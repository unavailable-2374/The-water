import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Play, Sparkles, Square } from 'lucide-react';
import { emptyBible, type Arc, type ChapterPlan, type StorylineDoc } from '@the-water/shared';
import { fmt, t } from '@/i18n';
import { Button, Dialog, Spinner, Textarea, cn, confirm } from '@/components/ui';
import { useAsyncData } from '@/components/data/useAsyncData';
import { toast } from '@/components/Toast';
import type { Novel } from '@/db/repos/novelsRepo';
import { getVersion, listChapters, type Chapter } from '@/db/repos/chaptersRepo';
import { latestBible } from '@/db/repos/bibleRepo';
import { buildStorylineDoc, latestSnapshot, listArcs, type StorylineSnapshot } from '@/db/repos/storylineRepo';
import { diffStoryline, summarizeDiff, type StorylineDiff } from '@/novel/storyline/diff';
import { buildRewritePlan, computeAffectedChapters, groupByArc, type AffectedChapter, type RewriteMode, type RewritePlanItem } from '@/novel/storyline/affected';
import { bibleAppearances } from '@/novel/bible';
import { getNovelProviders, startRewrite, wantsStyleCheck } from '@/novel/service';
import { estimateRewrite, formatCny } from '@/novel/pricing';
import { BudgetExceededError } from '@/db/repos/usageRepo';
import { CostEstimateLine, previewCost, previewCostForNovel, type CostPreview } from './UsagePanel';
import type { RewriteItemInput } from '@/jobs/planner';
import { rewritePlanPrompt } from '@/llm/prompts/rewritePlan';
import { renderChapterPlan } from '@/llm/prompts/context';
import { requestJson } from '@/llm/json';
import { providerForPurpose } from '@/llm/registry';

interface Props { novel: Novel; open: boolean; onClose: () => void; onStarted: () => void }

interface Computed { baseline: StorylineSnapshot; current: StorylineDoc; diff: StorylineDiff; chapters: Chapter[]; affected: AffectedChapter[]; arcs: Arc[] }
/** A plan row plus the editable, newline-separated instruction text. */
interface Row extends RewritePlanItem { instructions: string }

/** 只有圆点颜色是常量；文案在 `t.studio.rewritePlan.mode` 里现取。 */
const MODE_DOT: Record<RewriteMode, string> = { rewrite: 'bg-cinnabar-500', revise: 'bg-amber-500', name_replace: 'bg-tea-500' };
const STALE_DOT = 'bg-ink-300';
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const toRows = (items: RewritePlanItem[]): Row[] => items.map((it) => ({ ...it, instructions: it.reasons.map((r) => r.text).join('\n') }));
const splitLines = (text: string): string[] => text.split('\n').map((s) => s.trim()).filter(Boolean);

/** Diff the latest storyline snapshot against the live tables, list affected chapters, and submit a rewrite job. */
export function RewritePlanDialog({ novel, open, onClose, onStarted }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [generating, setGenerating] = useState(false);
  const [starting, setStarting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // 没有基线快照时返回 null：不是错误，是「先去记一版」。
  const { data: computed, error } = useAsyncData<Computed | null>(async () => {
    const baseline = await latestSnapshot(novel.id);
    if (!baseline) return null;
    const current = await buildStorylineDoc(novel.id, novel.premise, novel.meta.themes);
    const diff = diffStoryline(baseline.doc, current);
    const chapters = await listChapters(novel.id);
    const arcs = await listArcs(novel.id);
    let affected: AffectedChapter[] = [];
    if (!diff.isEmpty) {
      const writtenChapterNos = new Set(chapters.filter((c) => c.currentVersionId).map((c) => c.chapterNo));
      const maxChapterNo = chapters.reduce((m, c) => Math.max(m, c.chapterNo), 0);
      const bible = (await latestBible(novel.id))?.bible ?? emptyBible();
      const appearances = bibleAppearances(bible, maxChapterNo, current);
      affected = computeAffectedChapters({ diff, before: baseline.doc, after: current, appearances, writtenChapterNos });
    }
    return { baseline, current, diff, chapters, affected, arcs };
  }, { key: `rewritePlan:${novel.id}`, enabled: open });

  useEffect(() => {
    if (!open) { setRows([]); abortRef.current?.abort(); return; }
    if (computed === null) { toast.error(t.studio.rewritePlan.needSnapshot); onClose(); return; }
    if (computed) setRows(toRows(buildRewritePlan(computed.affected, { includeContinuity: false })));
  }, [open, computed]);

  useEffect(() => { if (open && error) { toast.error(errMsg(error)); onClose(); } }, [open, error]);

  const toggleContinuity = (on: boolean) => setRows((rs) => rs.map((r) => (r.stale ? { ...r, selected: on } : r)));
  const setRow = (chapterNo: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.chapterNo === chapterNo ? { ...r, ...patch } : r)));
  /** 整条故事弧一起勾 / 一起取消（§2.2 第 5 条）。 */
  const toggleGroup = (chapterNos: readonly number[], on: boolean) => {
    const set = new Set(chapterNos);
    setRows((rs) => rs.map((r) => (set.has(r.chapterNo) ? { ...r, selected: on } : r)));
  };

  const chapterByNo = useMemo(() => new Map((computed?.chapters ?? []).map((c) => [c.chapterNo, c] as const)), [computed]);
  const selectedRows = rows.filter((r) => r.selected);

  // §2.1 第 3 条：分开算输入 / 输出、强模型 / 便宜模型，并跳过不调模型的改名章。
  const selectionKey = rows.map((r) => `${r.chapterNo}:${r.selected ? 1 : 0}:${r.mode}`).join(',');
  const { data: cost } = useAsyncData<CostPreview>(async () => {
    const styleCheck = await wantsStyleCheck(novel.id);
    const items = rows
      .filter((r) => r.selected)
      .map((r) => ({ targetChars: chapterByNo.get(r.chapterNo)?.targetChars ?? 0, mode: r.mode }));
    return previewCostForNovel(novel.id, estimateRewrite(items, { styleCheck }));
  }, { key: `rewriteCost:${novel.id}:${selectionKey}`, enabled: open && !!computed });

  // §2.2 第 5 条：每章一行预估费用。只跟「这一章多少字、按什么模式改、走不走审校」
  // 有关，跟勾没勾无关，所以只在计划算好时跑一次，作者勾选时不重算。
  const affectedKey = (computed?.affected ?? []).map((a) => `${a.chapterNo}:${a.mode}`).join(',');
  const { data: rowCost } = useAsyncData<Record<number, CostPreview>>(async () => {
    if (!computed) return {};
    const styleCheck = await wantsStyleCheck(novel.id);
    const providerIds = await getNovelProviders(novel.id);
    const out: Record<number, CostPreview> = {};
    for (const a of computed.affected) {
      const targetChars = computed.chapters.find((c) => c.chapterNo === a.chapterNo)?.targetChars ?? 0;
      out[a.chapterNo] = await previewCost(estimateRewrite([{ targetChars, mode: a.mode }], { styleCheck }), providerIds);
    }
    return out;
  }, { key: `rewriteRowCost:${novel.id}:${affectedKey}`, enabled: open && !!computed });

  /** 一组章节的预估合计（未配置价格的按 0 算，界面上另有提示）。 */
  const sumCost = (items: readonly Row[]) => items.reduce((s, r) => s + (rowCost?.[r.chapterNo]?.costCny ?? 0), 0);
  const groups = useMemo(() => groupByArc(rows, computed?.arcs ?? []), [rows, computed]);

  // 改写前先让作者看一眼这一章现在写的是什么（§2.2 第 1 条）。
  const [previewNo, setPreviewNo] = useState<number | null>(null);
  const { data: previewText } = useAsyncData<string>(async () => {
    const id = previewNo == null ? undefined : chapterByNo.get(previewNo)?.currentVersionId;
    const v = id ? await getVersion(id) : null;
    return v?.content ?? t.studio.rewritePlan.previewEmpty;
  }, { key: `chapterPreview:${novel.id}:${previewNo ?? ''}`, enabled: previewNo != null });

  const staleRows = rows.filter((r) => r.stale);
  const continuityOn = staleRows.length > 0 && staleRows.every((r) => r.selected);
  const diffSummary = computed ? summarizeDiff(computed.diff, computed.current, computed.baseline.doc) : '';

  const generateInstructions = async () => {
    if (!computed) return;
    const targets = selectedRows.filter((r) => r.mode !== 'name_replace');
    if (targets.length === 0) { toast.info(t.studio.rewritePlan.noTarget); return; }
    const ac = new AbortController();
    abortRef.current = ac;
    setGenerating(true);
    try {
      const { provider } = await providerForPurpose('planning');
      const planFor = (chapterNo: number): ChapterPlan => {
        const plan = computed.current.chapters.find((c) => c.chapterNo === chapterNo);
        if (plan) return plan;
        const ch = chapterByNo.get(chapterNo);
        return { chapterNo, title: ch?.title ?? '', goal: ch?.goal ?? '', beatIds: ch?.beatIds ?? [], povCharacterId: ch?.povCharacterId ?? null, targetChars: ch?.targetChars ?? 0, endHook: ch?.endHook ?? '' };
      };
      const spec = rewritePlanPrompt({
        diffSummary,
        items: targets.map((r) => ({ chapterNo: r.chapterNo, mode: r.mode, reasons: r.reasons.map((x) => x.text), planText: renderChapterPlan(planFor(r.chapterNo), computed.current) })),
      });
      const { value } = await requestJson(provider, { ...spec, schema: spec.schema! }, { signal: ac.signal });
      let filled = 0;
      setRows((rs) => rs.map((r) => {
        const hit = value.find((v) => v.chapterNo === r.chapterNo);
        if (!hit || hit.instructions.length === 0 || !targets.some((x) => x.chapterNo === r.chapterNo)) return r;
        filled++;
        return { ...r, instructions: hit.instructions.join('\n') };
      }));
      toast.success(fmt(t.studio.rewritePlan.generated, { n: filled }));
    } catch (e) {
      if (!ac.signal.aborted) toast.error(errMsg(e));
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  };

  const start = async () => {
    if (!computed) return;
    const items: RewriteItemInput[] = [];
    for (const r of selectedRows) {
      const chapter = chapterByNo.get(r.chapterNo);
      if (!chapter) continue;
      const item: RewriteItemInput = { chapter, mode: r.mode, instructions: splitLines(r.instructions) };
      if (r.nameReplacements?.length) item.replacements = r.nameReplacements;
      items.push(item);
    }
    if (items.length === 0) { toast.error(t.studio.rewritePlan.pickAtLeastOne); return; }
    setStarting(true);
    try {
      try {
        await startRewrite(novel.id, items, computed.baseline.id);
      } catch (e) {
        if (!(e instanceof BudgetExceededError)) throw e;
        // 超预算不是错误，是需要作者点头的一次决定。
        const go = await confirm({ title: t.studio.rewritePlan.budgetTitle, description: fmt(t.studio.rewritePlan.budgetDesc, { message: e.message }), confirmText: t.studio.rewritePlan.budgetConfirm, tone: 'danger' });
        if (!go) return;
        await startRewrite(novel.id, items, computed.baseline.id, { ignoreBudget: true });
      }
      toast.success(fmt(t.studio.rewritePlan.started, { n: items.length }));
      onStarted();
      onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setStarting(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t.studio.rewritePlan.title} subtitle={t.studio.rewritePlan.subtitle} width="max-w-3xl">
      {!computed ? (
        <div className="flex items-center gap-2 py-12 text-sm text-ink-400" role="status"><Spinner />{t.studio.rewritePlan.comparing}</div>
      ) : computed.diff.isEmpty ? (
        <div className="py-12 text-center">
          <p className="font-serif text-base text-ink-700 dark:text-paper-100">{t.studio.rewritePlan.noChange}</p>
          <p className="mt-1 text-xs text-ink-400">{fmt(t.studio.rewritePlan.lastSnapshot, { time: new Date(computed.baseline.createdAt).toLocaleString() })}</p>
        </div>
      ) : (
        <div className="space-y-4">
          <details className="paper-texture rounded-2xl bg-paper-100 dark:bg-paper-800" open={rows.length === 0}>
            <summary className="cursor-pointer px-5 py-3 font-serif text-sm tracking-wide text-ink-800 dark:text-paper-100">{t.studio.rewritePlan.diffSummaryTitle}</summary>
            <pre className="mx-5 mb-4 max-h-48 overflow-auto whitespace-pre-wrap border-l-2 border-tea-200 pl-4 font-serif text-xs leading-relaxed text-ink-600 dark:border-tea-800 dark:text-ink-300">{diffSummary}</pre>
          </details>

          {rows.length === 0 ? (
            <p className="rounded-2xl bg-paper-0 p-5 text-sm leading-relaxed text-ink-600 shadow-soft dark:bg-paper-900 dark:text-ink-300">
              {t.studio.rewritePlan.noAffected}
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3 text-sm">
                <label className="inline-flex items-center gap-2 text-ink-700 dark:text-ink-200">
                  <input type="checkbox" checked={continuityOn} onChange={(e) => toggleContinuity(e.target.checked)} />
                  {t.studio.rewritePlan.continuity}
                  <span className="font-serif text-xs text-ink-400">{fmt(t.studio.rewritePlan.continuityCount, { n: staleRows.length })}</span>
                </label>
                <span className="text-xs text-ink-400">{fmt(t.studio.rewritePlan.selected, { picked: selectedRows.length, total: rows.length })}</span>
              </div>
              <CostEstimateLine preview={cost ?? null} prefix={t.studio.rewritePlan.costPrefix} />

              <div className="space-y-3">
                {groups.map((g) => {
                  const picked = g.items.filter((r) => r.selected).length;
                  const groupCost = sumCost(g.items.filter((r) => r.selected));
                  return (
                    <section key={g.arcId ?? '__none'} className="overflow-hidden rounded-2xl bg-paper-100/60 dark:bg-paper-800/50">
                      <header className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                        <input
                          type="checkbox"
                          checked={picked === g.items.length}
                          ref={(el) => { if (el) el.indeterminate = picked > 0 && picked < g.items.length; }}
                          onChange={(e) => toggleGroup(g.items.map((r) => r.chapterNo), e.target.checked)}
                          aria-label={fmt(t.studio.rewritePlan.groupToggle, { title: g.title })}
                        />
                        <span className="font-serif font-medium tracking-wide text-ink-900 dark:text-paper-100">{g.title}</span>
                        {g.startChapterNo != null && <span className="font-serif text-xs text-ink-400">{fmt(t.studio.rewritePlan.arcRange, { from: g.startChapterNo, to: g.endChapterNo ?? g.startChapterNo })}</span>}
                        <span className="ml-auto text-xs text-ink-500">
                          {fmt(t.studio.rewritePlan.selected, { picked, total: g.items.length })}
                          {picked > 0 && <> · {t.studio.rewritePlan.about}<span className="font-serif text-cinnabar-700 dark:text-cinnabar-100">{formatCny(groupCost)}</span></>}
                        </span>
                      </header>
                      <ul aria-label={t.studio.rewritePlan.list} className="space-y-2 px-2 pb-2">
                        {g.items.map((r) => {
                          const ch = chapterByNo.get(r.chapterNo);
                          const markDot = r.stale ? STALE_DOT : MODE_DOT[r.mode];
                          const markLabel = r.stale ? t.studio.rewritePlan.continuityMark : t.studio.rewritePlan.mode[r.mode];
                          const rc = rowCost?.[r.chapterNo];
                          return (
                            <li key={r.chapterNo} className={cn('rounded-2xl bg-paper-0 p-4 shadow-soft transition dark:bg-paper-900', !r.selected && 'opacity-60')}>
                              <div className="flex items-start gap-3">
                                <input type="checkbox" className="mt-1" aria-label={fmt(t.studio.rewritePlan.pickChapter, { n: r.chapterNo })} checked={r.selected} onChange={(e) => setRow(r.chapterNo, { selected: e.target.checked })} />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 text-sm">
                                    <span className="font-serif font-medium text-ink-900 dark:text-paper-100">{fmt(t.studio.chapterNo, { n: r.chapterNo })}</span>
                                    <span className="truncate font-serif text-ink-600 dark:text-ink-300">{ch?.title}</span>
                                    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-ink-500"><span className={cn('h-1.5 w-1.5 rounded-full', markDot)} aria-hidden="true" />{markLabel}</span>
                                    {ch && <span className="ml-auto shrink-0 font-serif text-xs text-ink-400">{fmt(t.studio.chaptersTab.charCount, { n: ch.targetChars.toLocaleString() })}</span>}
                                    <button
                                      className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-xs text-ink-500 transition hover:bg-paper-200/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-tea-500/50 dark:hover:bg-paper-800', previewNo === r.chapterNo && 'bg-paper-200/70 dark:bg-paper-800')}
                                      title={t.studio.rewritePlan.previewTitle}
                                      aria-expanded={previewNo === r.chapterNo}
                                      onClick={() => setPreviewNo(previewNo === r.chapterNo ? null : r.chapterNo)}
                                    ><BookOpen size={12} strokeWidth={1.75} className="inline" aria-hidden="true" /> {t.studio.rewritePlan.preview}</button>
                                    {/* 每章预估费用（§2.2 第 5 条）：改名是本地替换，不调模型 */}
                                    <span className="shrink-0 text-xs text-ink-400">
                                      {r.mode === 'name_replace' ? t.studio.rewritePlan.free : !rc ? t.studio.rewritePlan.costing : rc.priced ? <>{t.studio.rewritePlan.about}<span className="font-serif text-cinnabar-700 dark:text-cinnabar-100">{formatCny(rc.costCny)}</span></> : t.studio.rewritePlan.unpriced}
                                    </span>
                                  </div>
                                  <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs leading-relaxed text-ink-600 dark:text-ink-300">
                                    {r.reasons.map((x, i) => <li key={i}>{x.text}</li>)}
                                  </ul>
                                  {previewNo === r.chapterNo && (
                                    <pre className="prose-novel mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-xl bg-paper-100 px-4 py-3 text-xs leading-relaxed text-ink-700 dark:bg-paper-800 dark:text-ink-200">{previewText ?? t.studio.rewritePlan.previewLoading}</pre>
                                  )}
                                  {r.mode === 'name_replace' ? (
                                    r.nameReplacements?.length ? (
                                      <p className="mt-1.5 text-xs text-ink-500">{fmt(t.studio.rewritePlan.renames, { list: r.nameReplacements.map((pair) => `${pair.from} → ${pair.to}`).join('；') })}</p>
                                    ) : null
                                  ) : r.selected ? (
                                    <Textarea className="mt-2 text-xs" aria-label={t.studio.rewritePlan.instructionsPlaceholder} rows={Math.min(6, Math.max(2, splitLines(r.instructions).length))} placeholder={t.studio.rewritePlan.instructionsPlaceholder} value={r.instructions} onChange={(e) => setRow(r.chapterNo, { instructions: e.target.value })} />
                                  ) : null}
                                </div>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  );
                })}
              </div>

              <div className="flex items-center gap-2 pt-1">
                {generating ? (
                  <Button size="sm" onClick={() => abortRef.current?.abort()}><Square size={14} strokeWidth={1.75} aria-hidden="true" />{t.studio.rewritePlan.stop}</Button>
                ) : (
                  <Button size="sm" variant="ai" disabled={starting || selectedRows.every((r) => r.mode === 'name_replace')} onClick={generateInstructions}><Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />{t.studio.rewritePlan.generate}</Button>
                )}
                {generating && <span className="flex items-center gap-1.5 text-xs text-tea-700 dark:text-tea-200" role="status"><Spinner className="h-3 w-3" />{t.studio.rewritePlan.generating}</span>}
                <div className="ml-auto flex items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
                  <Button size="sm" variant="primary" disabled={starting || generating || selectedRows.length === 0} onClick={start}>
                    {starting ? <Spinner className="h-3 w-3 border-paper-0/40 border-t-paper-0" /> : <Play size={14} strokeWidth={1.75} aria-hidden="true" />}{fmt(t.studio.rewritePlan.start, { n: selectedRows.length })}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
