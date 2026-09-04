import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Sparkles, Square } from 'lucide-react';
import { emptyBible, type ChapterPlan, type StorylineDoc } from '@the-water/shared';
import { t } from '@/i18n/zh';
import { Button, Dialog, Spinner, Textarea, cn } from '@/components/ui';
import { toast } from '@/components/Toast';
import type { Novel } from '@/db/repos/novelsRepo';
import { listChapters, type Chapter } from '@/db/repos/chaptersRepo';
import { latestBible } from '@/db/repos/bibleRepo';
import { buildStorylineDoc, latestSnapshot, type StorylineSnapshot } from '@/db/repos/storylineRepo';
import { diffStoryline, summarizeDiff, type StorylineDiff } from '@/novel/storyline/diff';
import { buildRewritePlan, computeAffectedChapters, type AffectedChapter, type RewriteMode, type RewritePlanItem } from '@/novel/storyline/affected';
import { bibleAppearances } from '@/novel/bible';
import { startRewrite } from '@/novel/service';
import type { RewriteItemInput } from '@/jobs/planner';
import { rewritePlanPrompt } from '@/llm/prompts/rewritePlan';
import { renderChapterPlan } from '@/llm/prompts/context';
import { requestJson } from '@/llm/json';
import { providerForPurpose } from '@/llm/registry';

interface Props { novel: Novel; open: boolean; onClose: () => void; onStarted: () => void }

interface Computed { baseline: StorylineSnapshot; current: StorylineDoc; diff: StorylineDiff; chapters: Chapter[]; affected: AffectedChapter[] }
/** A plan row plus the editable, newline-separated instruction text. */
interface Row extends RewritePlanItem { instructions: string }

const MODE_MARK: Record<RewriteMode, { label: string; dot: string }> = {
  rewrite: { label: '重写', dot: 'bg-cinnabar-500' }, revise: { label: '修改', dot: 'bg-amber-500' }, name_replace: { label: '改名', dot: 'bg-tea-500' },
};
const STALE_MARK = { label: '连贯', dot: 'bg-ink-300' };
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const toRows = (items: RewritePlanItem[]): Row[] => items.map((it) => ({ ...it, instructions: it.reasons.map((r) => r.text).join('\n') }));
const splitLines = (text: string): string[] => text.split('\n').map((s) => s.trim()).filter(Boolean);

/** Diff the latest storyline snapshot against the live tables, list affected chapters, and submit a rewrite job. */
export function RewritePlanDialog({ novel, open, onClose, onStarted }: Props) {
  const [computed, setComputed] = useState<Computed | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [includeContinuity, setIncludeContinuity] = useState(false);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [starting, setStarting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      setComputed(null); setRows([]); setIncludeContinuity(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const baseline = await latestSnapshot(novel.id);
        if (!baseline) { toast.error('还没有记下过故事线版本，先记一版再来比较'); onClose(); return; }
        const current = await buildStorylineDoc(novel.id, novel.premise, novel.meta.themes);
        const diff = diffStoryline(baseline.doc, current);
        const chapters = await listChapters(novel.id);
        let affected: AffectedChapter[] = [];
        if (!diff.isEmpty) {
          const writtenChapterNos = new Set(chapters.filter((c) => c.currentVersionId).map((c) => c.chapterNo));
          const maxChapterNo = chapters.reduce((m, c) => Math.max(m, c.chapterNo), 0);
          const bible = (await latestBible(novel.id))?.bible ?? emptyBible();
          const appearances = bibleAppearances(bible, maxChapterNo, current);
          affected = computeAffectedChapters({ diff, before: baseline.doc, after: current, appearances, writtenChapterNos });
        }
        if (cancelled) return;
        setComputed({ baseline, current, diff, chapters, affected });
        setRows(toRows(buildRewritePlan(affected, { includeContinuity: false })));
      } catch (e) {
        if (!cancelled) { toast.error(errMsg(e)); onClose(); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, novel.id]);

  const toggleContinuity = (on: boolean) => {
    setIncludeContinuity(on);
    setRows((rs) => rs.map((r) => (r.stale ? { ...r, selected: on } : r)));
  };
  const setRow = (chapterNo: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.chapterNo === chapterNo ? { ...r, ...patch } : r)));

  const chapterByNo = useMemo(() => new Map((computed?.chapters ?? []).map((c) => [c.chapterNo, c] as const)), [computed]);
  const selectedRows = rows.filter((r) => r.selected);
  const estTokens = selectedRows.filter((r) => r.mode !== 'name_replace').reduce((s, r) => s + (chapterByNo.get(r.chapterNo)?.targetChars ?? 0) * 2, 0);
  const diffSummary = computed ? summarizeDiff(computed.diff, computed.current, computed.baseline.doc) : '';

  const generateInstructions = async () => {
    if (!computed) return;
    const targets = selectedRows.filter((r) => r.mode !== 'name_replace');
    if (targets.length === 0) { toast.info('没有需要写说明的章节'); return; }
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
      toast.success(`AI 为 ${filled} 章写好了改写说明`);
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
    if (items.length === 0) { toast.error('至少选一章'); return; }
    setStarting(true);
    try {
      await startRewrite(novel.id, items, computed.baseline.id);
      toast.success(`AI 开始改写 ${items.length} 章`);
      onStarted();
      onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setStarting(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} title="看看哪些章节需要改" subtitle="把现在的故事线和上一版比一比，找出受影响的章节" width="max-w-3xl">
      {loading || !computed ? (
        <div className="flex items-center gap-2 py-12 text-sm text-ink-400"><Spinner />正在比较故事线，找出受影响的章节…</div>
      ) : computed.diff.isEmpty ? (
        <div className="py-12 text-center">
          <p className="font-serif text-base text-ink-700 dark:text-paper-100">故事线没有变化，章节不需要跟着改。</p>
          <p className="mt-1 text-xs text-ink-400">上一版记于 {new Date(computed.baseline.createdAt).toLocaleString()}</p>
        </div>
      ) : (
        <div className="space-y-4">
          <details className="paper-texture rounded-2xl bg-paper-100 dark:bg-paper-800" open={rows.length === 0}>
            <summary className="cursor-pointer px-5 py-3 font-serif text-sm tracking-wide text-ink-800 dark:text-paper-100">故事线改了什么</summary>
            <pre className="mx-5 mb-4 max-h-48 overflow-auto whitespace-pre-wrap border-l-2 border-tea-200 pl-4 font-serif text-xs leading-relaxed text-ink-600 dark:border-tea-800 dark:text-ink-300">{diffSummary}</pre>
          </details>

          {rows.length === 0 ? (
            <p className="rounded-2xl bg-paper-0 p-5 text-sm leading-relaxed text-ink-600 shadow-soft dark:bg-paper-900 dark:text-ink-300">
              这些改动没有影响到任何已经写好的章节。以后的章节会自动按新的故事线来写，只要点「记下这一版」就好。
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3 text-sm">
                <label className="inline-flex items-center gap-2 text-ink-700 dark:text-ink-200">
                  <input type="checkbox" checked={includeContinuity} onChange={(e) => toggleContinuity(e.target.checked)} />
                  后面的章节也顺一遍，保持连贯
                  <span className="font-serif text-xs text-ink-400">{rows.filter((r) => r.stale).length} 章</span>
                </label>
                <span className="text-xs text-ink-400">已选 <span className="font-serif">{selectedRows.length} / {rows.length}</span> 章 · 大约 <span className="font-serif">{estTokens.toLocaleString()}</span> tokens</span>
              </div>

              <ul className="space-y-2">
                {rows.map((r) => {
                  const ch = chapterByNo.get(r.chapterNo);
                  const mark = r.stale ? STALE_MARK : MODE_MARK[r.mode];
                  return (
                    <li key={r.chapterNo} className={cn('rounded-2xl bg-paper-0 p-4 shadow-soft transition dark:bg-paper-900', !r.selected && 'opacity-60')}>
                      <div className="flex items-start gap-3">
                        <input type="checkbox" className="mt-1" checked={r.selected} onChange={(e) => setRow(r.chapterNo, { selected: e.target.checked })} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 text-sm">
                            <span className="font-serif font-medium text-ink-900 dark:text-paper-100">第{r.chapterNo}章</span>
                            <span className="truncate font-serif text-ink-600 dark:text-ink-300">{ch?.title}</span>
                            <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-ink-500"><span className={cn('h-1.5 w-1.5 rounded-full', mark.dot)} />{mark.label}</span>
                            {ch && <span className="ml-auto shrink-0 font-serif text-xs text-ink-400">{ch.targetChars.toLocaleString()} 字</span>}
                          </div>
                          <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs leading-relaxed text-ink-600 dark:text-ink-300">
                            {r.reasons.map((x, i) => <li key={i}>{x.text}</li>)}
                          </ul>
                          {r.mode === 'name_replace' ? (
                            r.nameReplacements?.length ? (
                              <p className="mt-1.5 text-xs text-ink-500">改名：{r.nameReplacements.map((p) => `${p.from} → ${p.to}`).join('；')}</p>
                            ) : null
                          ) : r.selected ? (
                            <Textarea className="mt-2 text-xs" rows={Math.min(6, Math.max(2, splitLines(r.instructions).length))} placeholder="每行一条，告诉 AI 这一章要怎么改" value={r.instructions} onChange={(e) => setRow(r.chapterNo, { instructions: e.target.value })} />
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>

              <div className="flex items-center gap-2 pt-1">
                {generating ? (
                  <Button size="sm" onClick={() => abortRef.current?.abort()}><Square size={14} strokeWidth={1.75} />停下</Button>
                ) : (
                  <Button size="sm" variant="ai" disabled={starting || selectedRows.every((r) => r.mode === 'name_replace')} onClick={generateInstructions}><Sparkles size={14} strokeWidth={1.75} />让 AI 写改写说明（可选）</Button>
                )}
                {generating && <span className="flex items-center gap-1.5 text-xs text-tea-700 dark:text-tea-200"><Spinner className="h-3 w-3" />AI 正在写…</span>}
                <div className="ml-auto flex items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
                  <Button size="sm" variant="primary" disabled={starting || generating || selectedRows.length === 0} onClick={start}>
                    {starting ? <Spinner className="h-3 w-3 border-paper-0/40 border-t-paper-0" /> : <Play size={14} strokeWidth={1.75} />}开始改写 {selectedRows.length} 章
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
