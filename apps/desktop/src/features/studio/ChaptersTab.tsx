import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { History, Maximize2, Minimize2, CheckCircle2, RotateCcw, Sparkles, Download, BookOpen, ShieldCheck } from 'lucide-react';
import { countZh } from '@the-water/shared';
import { t } from '@/i18n/zh';
import { Button, Dialog, EmptyState, Field, Input, Select, cn } from '@/components/ui';
import { toast } from '@/components/Toast';
import type { Novel } from '@/db/repos/novelsRepo';
import { createVersion, getVersion, listChapters, listVersions, restoreVersion, setChapterStatus, type Chapter, type ChapterVersion } from '@/db/repos/chaptersRepo';
import { createJob } from '@/db/repos/jobsRepo';
import { regenerateChapter, startGeneration, startStyleCheck } from '@/novel/service';
import { latestReviewForChapter, type ChapterReview } from '@/db/repos/reviewsRepo';
import { mergedGenreOf } from '@/novel/genrePacks';
import { getStyleExtras } from '@/db/repos/storylineRepo';
import { recordUserEdit } from '@/db/repos/feedbackRepo';
import { lintText, type LintReport } from '@/novel/lint';
import type { StyleProfile } from '@the-water/shared';
import { kick } from '@/jobs/runner';
import { activeJobsForNovel, useJobs } from '@/stores/jobsStore';
import { getSetting, setSetting } from '@/db/repos/settingsRepo';
import { FORMAT_LABEL, exportNovel, type ExportFormat } from '@/novel/export';

const STATUS: Record<Chapter['status'], { label: string; dot: string }> = {
  planned: { label: t.studio.planned, dot: 'bg-paper-400' }, generating: { label: t.studio.generating, dot: 'bg-tea-500 animate-pulse' }, draft: { label: t.studio.draft, dot: 'bg-amber-500' },
  final: { label: t.studio.final, dot: 'bg-tea-600' }, stale: { label: t.studio.stale, dot: 'bg-cinnabar-500' },
};
const SOURCE_LABEL: Record<ChapterVersion['source'], string> = { generated: 'AI 初稿', rewritten: 'AI 改写', topup: 'AI 扩写', trim: 'AI 精简', user_edit: '手动修改', imported: '导入' };

const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
/** Chinese numeral for chapter headings (1–999); falls back to Arabic beyond that. */
function zhNum(n: number): string {
  if (!Number.isInteger(n) || n <= 0 || n >= 1000) return String(n);
  if (n < 10) return DIGITS[n]!;
  if (n < 20) return `十${n % 10 ? DIGITS[n % 10] : ''}`;
  if (n < 100) return `${DIGITS[Math.floor(n / 10)]}十${n % 10 ? DIGITS[n % 10] : ''}`;
  const h = Math.floor(n / 100); const tens = Math.floor((n % 100) / 10); const u = n % 10;
  let s = `${DIGITS[h]}百`;
  if (tens) s += `${DIGITS[tens]}十`; else if (u) s += '零';
  if (u) s += DIGITS[u];
  return s;
}

export function ChaptersTab({ novel }: { novel: Novel }) {
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const tick = useJobs((s) => s.novelTick[novel.id] ?? 0);
  const jobs = useJobs((s) => s.jobs);
  const live = useJobs((s) => s.live);
  const active = activeJobsForNovel(jobs, novel.id)[0];
  const liveText = active ? live[active.id]?.text : undefined;
  const liveStepId = active ? live[active.id]?.stepId : undefined;
  const steps = useJobs((s) => (active ? s.steps[active.id] : undefined));
  const liveChapterId = useMemo(() => steps?.find((s) => s.id === liveStepId)?.chapterId ?? null, [steps, liveStepId]);
  useEffect(() => { if (active && !steps) void useJobs.getState().loadSteps(active.id); }, [active?.id, steps]);

  const reload = async () => {
    const list = await listChapters(novel.id);
    setChapters(list);
    if (!selectedId && list[0]) setSelectedId(list[0].id);
  };
  useEffect(() => { void reload(); }, [novel.id, tick]);
  const selected = chapters.find((c) => c.id === selectedId) ?? null;
  const unwritten = chapters.filter((c) => !c.currentVersionId).length;

  return (
    <div className="grid h-full grid-rows-[minmax(0,1fr)] grid-cols-[280px_1fr] bg-paper-50 dark:bg-paper-950">
      <aside className="flex flex-col border-r border-paper-300/60 bg-paper-100/60 dark:border-paper-800 dark:bg-paper-900/60">
        <div className="px-5 pt-5 pb-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="font-serif text-base font-semibold tracking-wide text-ink-900 dark:text-paper-100">目录</div>
              <div className="mt-0.5 text-xs text-ink-400">已写 <span className="font-serif">{chapters.length - unwritten}</span> / <span className="font-serif">{chapters.length}</span> 章</div>
            </div>
            <Button size="sm" variant="ghost" className="px-2" title="导出：TXT / Markdown / EPUB / DOCX" onClick={() => setExportOpen(true)}><Download size={16} strokeWidth={1.75} /></Button>
          </div>
          {unwritten > 0 && !active && (
            <Button size="sm" variant="ai" className="mt-3 w-full" onClick={async () => { try { await startGeneration(novel.id); toast.success('AI 开始动笔了'); } catch (e) { toast.error(String(e instanceof Error ? e.message : e)); } }}><Sparkles size={14} strokeWidth={1.75} />让 AI 写完剩下的 {unwritten} 章</Button>
          )}
        </div>
        <ul className="flex-1 overflow-y-auto px-3 pb-4">
          {chapters.map((c) => {
            const isLive = liveChapterId === c.id;
            const st = isLive ? STATUS.generating : STATUS[c.status];
            return (
              <li key={c.id}>
                <button onClick={() => setSelectedId(c.id)} className={cn('mb-0.5 flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left transition', selectedId === c.id ? 'bg-paper-0 shadow-soft dark:bg-paper-800' : 'hover:bg-paper-200/60 dark:hover:bg-paper-800/60')}>
                  <span className="w-7 shrink-0 pt-0.5 font-serif text-sm text-ink-400">{zhNum(c.chapterNo)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-serif text-sm tracking-wide text-ink-900 dark:text-paper-100">{c.title || `第${zhNum(c.chapterNo)}章`}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-400">
                      <span className={cn('h-1.5 w-1.5 rounded-full', st.dot)} />{st.label}
                      <span>·</span><span className="font-serif">{c.targetChars.toLocaleString()} 字</span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
      <section className="min-w-0 overflow-hidden">
        {selected ? <ChapterEditor key={selected.id} novel={novel} chapter={selected} liveText={liveChapterId === selected.id ? liveText : undefined} busy={!!active} onChanged={reload} /> : <EmptyState icon={<BookOpen size={40} strokeWidth={1.25} />} title="从目录里挑一章" description="选中一章，就可以在这张稿纸上读、改，或者交给 AI 重写。" />}
      </section>
      <ExportDialog novel={novel} chapters={chapters} open={exportOpen} onClose={() => setExportOpen(false)} />
    </div>
  );
}

const FORMATS: ExportFormat[] = ['txt', 'md', 'epub', 'docx'];
const DEFAULT_LICENSE = '保留所有权利';

/** 导出对话框：选格式、挑章节范围、补作者与许可，元数据会写进文件里。 */
function ExportDialog({ novel, chapters, open, onClose }: { novel: Novel; chapters: Chapter[]; open: boolean; onClose: () => void }) {
  const written = chapters.filter((c) => c.currentVersionId);
  const first = written[0]?.chapterNo ?? 1;
  const last = written[written.length - 1]?.chapterNo ?? 1;
  const [format, setFormat] = useState<ExportFormat>('txt');
  const [whole, setWhole] = useState(true);
  const [from, setFrom] = useState(first);
  const [to, setTo] = useState(last);
  const [author, setAuthor] = useState('');
  const [license, setLicense] = useState(DEFAULT_LICENSE);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFrom(first); setTo(last);
    void (async () => {
      setAuthor(await getSetting('exportAuthor', ''));
      setLicense(await getSetting('exportLicense', DEFAULT_LICENSE));
    })();
  }, [open, first, last]);

  const count = written.filter((c) => whole || (c.chapterNo >= from && c.chapterNo <= to)).length;
  const doExport = async () => {
    setBusy(true);
    try {
      await setSetting('exportAuthor', author);
      await setSetting('exportLicense', license);
      const path = await exportNovel(novel, format, { range: whole ? null : { from, to }, meta: { author, license } });
      if (path) { toast.success(`已导出到 ${path}`); onClose(); }
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} title="导出这本书" subtitle="书名、作者、简介、许可会一并写进文件" width="max-w-md">
      <div className="space-y-4">
        <Field label="格式">
          <Select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
            {FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}
          </Select>
        </Field>
        <Field label="章节范围" hint={written.length === 0 ? '还没有写好的章节' : `已写 ${written.length} 章（第 ${first}–${last} 章），这次导出 ${count} 章`}>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-sm text-ink-600 dark:text-ink-300">
              <input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} />全书
            </label>
            <Input type="number" className="w-20" min={first} max={last} value={from} disabled={whole} onChange={(e) => setFrom(Number(e.target.value))} />
            <span className="text-ink-400">–</span>
            <Input type="number" className="w-20" min={first} max={last} value={to} disabled={whole} onChange={(e) => setTo(Number(e.target.value))} />
            <span className="text-sm text-ink-400">章</span>
          </div>
        </Field>
        <Field label="作者" hint="会写进文件元数据，下次还用这个"><Input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="署名" /></Field>
        <Field label="许可"><Input value={license} onChange={(e) => setLicense(e.target.value)} placeholder={DEFAULT_LICENSE} /></Field>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button onClick={onClose}>{t.common.cancel}</Button>
        <Button variant="primary" disabled={busy || count === 0} onClick={doExport}><Download size={14} strokeWidth={1.75} />{busy ? '正在导出…' : '导出'}</Button>
      </div>
    </Dialog>
  );
}

function ChapterEditor({ novel, chapter, liveText, busy, onChanged }: { novel: Novel; chapter: Chapter; liveText?: string; busy: boolean; onChanged: () => Promise<void> }) {
  const [version, setVersion] = useState<ChapterVersion | null>(null);
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [versions, setVersions] = useState<ChapterVersion[]>([]);
  const [review, setReview] = useState<ChapterReview | null>(null);
  const [showReview, setShowReview] = useState(false);
  const [profile, setProfile] = useState<StyleProfile | null>(null);
  const [lint, setLint] = useState<LintReport | null>(null);
  const [showLint, setShowLint] = useState(false);
  const saveTimer = useRef<number | null>(null);
  const lintTimer = useRef<number | null>(null);
  const tick = useJobs((s) => s.novelTick[novel.id] ?? 0);

  useEffect(() => { void getStyleExtras(novel.id).then((x) => setProfile(x.styleProfile)); }, [novel.id, tick]);
  useEffect(() => { void latestReviewForChapter(chapter.id).then(setReview); }, [chapter.id, chapter.currentVersionId, tick]);

  useEffect(() => {
    (async () => {
      const v = chapter.currentVersionId ? await getVersion(chapter.currentVersionId) : null;
      setVersion(v); setText(v?.content ?? ''); setDirty(false);
      if (showVersions) setVersions(await listVersions(chapter.id));
    })();
  }, [chapter.id, chapter.currentVersionId, tick]);

  // local QC (docs/writing/lexicon/lint-rules.md + 题材层负面清单), 500ms debounce
  const genre = mergedGenreOf(novel.requirements);
  useEffect(() => {
    const val = liveText !== undefined && liveText !== '' ? liveText : text;
    if (lintTimer.current) window.clearTimeout(lintTimer.current);
    if (countZh(val) < 200) { setLint(null); return; }
    lintTimer.current = window.setTimeout(() => setLint(lintText(val, { profile, genre })), 500);
    return () => { if (lintTimer.current) window.clearTimeout(lintTimer.current); };
  }, [text, liveText, profile, genre]);

  const scheduleSave = (val: string) => {
    setText(val); setDirty(true);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      if (val.trim() === (version?.content ?? '').trim()) { setDirty(false); return; }
      await createVersion({ chapterId: chapter.id, content: val, source: 'user_edit', summary: version?.summary ?? '', status: chapter.status === 'final' ? 'final' : 'draft' });
      setDirty(false);
      // learning layer: what the user deletes from an AI draft becomes a soft negative
      if (version && ['generated', 'rewritten', 'topup', 'trim'].includes(version.source)) {
        try {
          const learned = await recordUserEdit(novel.id, version.content, val);
          if (learned.length) toast.success(`已学到你不喜欢的用词：${learned.slice(0, 5).join('、')}`);
        } catch (e) { console.warn('recordUserEdit failed', e); }
      }
      await onChanged();
    }, 2000);
  };

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast.success(ok); await onChanged(); } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };
  const adjust = (kind: 'expand' | 'trim') => act(async () => {
    // one-off adjust job: reuse adjust_length step by temporarily pushing target
    const job = await createJob({ novelId: novel.id, type: 'regenerate_chapter', params: { chapterNo: chapter.chapterNo, adjust: kind }, providerId: null, steps: [{ kind: 'adjust_length', chapterId: chapter.id, input: { chapterNo: chapter.chapterNo, force: kind } }] });
    kick();
    return job;
  }, kind === 'expand' ? 'AI 稍后会来扩写这一章' : 'AI 稍后会来精简这一章');

  const displayText = liveText !== undefined && liveText !== '' ? liveText : text;
  const count = countZh(displayText);
  const ratio = chapter.targetChars ? Math.round((count / chapter.targetChars) * 100) : 0;
  const isFinal = chapter.status === 'final';

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-start gap-3 px-8 pt-5 pb-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-serif text-lg font-semibold tracking-wide text-ink-900 dark:text-paper-100">第{zhNum(chapter.chapterNo)}章　{chapter.title}</h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-400">
            <span className={cn('font-serif', (ratio < 88 || ratio > 120) && count > 0 && 'text-amber-700 dark:text-amber-300')}>{count.toLocaleString()} / {chapter.targetChars.toLocaleString()} 字 · {ratio}%</span>
            {version && <span>第 <span className="font-serif">{version.versionNo}</span> 稿 · {SOURCE_LABEL[version.source] ?? version.source}</span>}
            {dirty && <span className="text-tea-700 dark:text-tea-200">正在保存…</span>}
            {lint && (
              <button className={cn('rounded-md px-1.5 py-0.5 transition hover:bg-paper-200/70 dark:hover:bg-paper-800', showLint && 'bg-paper-200/70 dark:bg-paper-800', lint.aiTellScore < 70 ? 'text-amber-700 dark:text-amber-300' : 'text-ink-500')} onClick={() => setShowLint((v) => !v)} title="本地质检：AI 味与禁忌用词">
                AI 味 <span className="font-serif">{lint.aiTellScore}</span> 分 · <span className="font-serif">{lint.issues.length}</span> 处提示
              </button>
            )}
            {review && (
              <button className={cn('rounded-md px-1.5 py-0.5 transition hover:bg-paper-200/70 dark:hover:bg-paper-800', showReview && 'bg-paper-200/70 dark:bg-paper-800', review.verdict === 'revise' ? 'text-cinnabar-700 dark:text-cinnabar-100' : 'text-tea-700 dark:text-tea-200')} onClick={() => setShowReview((v) => !v)} title="最近一次审校报告">
                风格 <span className="font-serif">{review.styleScore}</span> 分 · {review.verdict === 'pass' ? '通过' : '需修订'}{review.oocCount ? ` · OOC ${review.oocCount}` : ''}
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className="px-2" disabled={busy || !version} title={t.studio.expand} onClick={() => adjust('expand')}><Maximize2 size={16} strokeWidth={1.75} /></Button>
          <Button size="sm" variant="ghost" className="px-2" disabled={busy || !version} title={t.studio.trim} onClick={() => adjust('trim')}><Minimize2 size={16} strokeWidth={1.75} /></Button>
          <Button size="sm" variant="ghost" className={cn('px-2', isFinal && 'text-tea-700 dark:text-tea-200')} disabled={!version} title={isFinal ? '取消定稿' : t.studio.finalize} onClick={() => act(() => setChapterStatus(chapter.id, isFinal ? 'draft' : 'final', []), isFinal ? '已取消定稿' : '这一章定稿了')}><CheckCircle2 size={16} strokeWidth={1.75} /></Button>
          <Button size="sm" variant="ghost" className={cn('px-2', showVersions && 'bg-paper-200/70 text-ink-900 dark:bg-paper-800')} title={t.studio.versions} onClick={async () => { setShowVersions(!showVersions); setVersions(await listVersions(chapter.id)); }}><History size={16} strokeWidth={1.75} /></Button>
          <Button size="sm" variant="ghost" className="px-2" disabled={busy || !version} title="审校这一章：文风贴合度、人物是否出戏、与设定是否矛盾" onClick={() => act(() => startStyleCheck(novel.id, chapter.chapterNo), 'AI 稍后会来审校这一章')}><ShieldCheck size={16} strokeWidth={1.75} /></Button>
          <Button size="sm" variant="ai" className="ml-2" disabled={busy} onClick={() => act(() => regenerateChapter(novel.id, chapter.chapterNo), 'AI 稍后会来重写这一章')}><Sparkles size={14} strokeWidth={1.75} />让 AI 重写这一章</Button>
        </div>
      </div>
      {chapter.status === 'stale' && chapter.staleReasons.length > 0 && <div className="mx-8 mb-2 rounded-xl bg-cinnabar-50 px-4 py-2 text-xs leading-relaxed text-cinnabar-700 dark:bg-cinnabar-700/20 dark:text-cinnabar-100">故事线改了，这一章可能要跟着改：{chapter.staleReasons.join('；')}</div>}
      {chapter.goal && <div className="mx-8 mb-3 text-xs leading-relaxed text-ink-400">本章目标：{chapter.goal}</div>}
      {showLint && lint && (
        <div className="mx-8 mb-3 max-h-40 overflow-y-auto rounded-xl bg-paper-100 px-4 py-2 text-xs leading-relaxed text-ink-700 dark:bg-paper-800 dark:text-ink-200">
          {lint.issues.length === 0 && <span className="text-ink-400">没有发现 AI 味或禁忌用词。</span>}
          <ul className="space-y-0.5">
            {lint.issues.slice(0, 30).map((i, k) => (
              <li key={k} className="flex gap-2"><span className={cn('shrink-0 font-serif', i.severity === 'block' ? 'text-cinnabar-600' : 'text-amber-600')}>{i.severity === 'block' ? '打回' : '提示'}</span><span>{i.message}{i.quote && <span className="text-ink-400">　「{i.quote}」</span>}</span></li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex min-h-0 flex-1 gap-4 px-8 pb-6">
        <div className="paper-texture mx-auto flex h-full min-w-0 max-w-3xl flex-1 flex-col rounded-2xl bg-paper-0 shadow-soft dark:bg-paper-900">
          {liveText !== undefined && liveText !== '' ? (
            <div className="prose-novel flex-1 overflow-y-auto whitespace-pre-wrap px-14 py-12 text-ink-900 dark:text-paper-100">{liveText}<span className="ml-0.5 inline-block h-[1.1em] w-0.5 animate-pulse bg-tea-500 align-text-bottom" /></div>
          ) : (
            <textarea className="prose-novel flex-1 resize-none border-0 bg-transparent px-14 py-12 text-ink-900 outline-none placeholder:text-ink-300 dark:text-paper-100" value={text} onChange={(e) => scheduleSave(e.target.value)} placeholder={version ? '' : '这一章还是空白的稿纸。可以自己写，也可以让 AI 来写。'} spellCheck={false} />
          )}
        </div>
        {showReview && review && <ReviewPanel review={review} />}
        {showVersions && (
          <aside className="w-64 shrink-0 overflow-y-auto rounded-2xl bg-paper-0 p-4 text-xs shadow-soft dark:bg-paper-900">
            <h3 className="mb-3 font-serif text-sm font-semibold tracking-wide text-ink-800 dark:text-paper-100">{t.studio.versions}</h3>
            <ul className="space-y-2">
              {versions.map((v) => {
                const current = v.id === chapter.currentVersionId;
                return (
                  <li key={v.id} className={cn('rounded-xl p-3', current ? 'bg-tea-50 ring-1 ring-tea-200 dark:bg-tea-800/30 dark:ring-tea-800' : 'bg-paper-100 dark:bg-paper-800')}>
                    <div className="flex items-baseline justify-between"><span className="font-serif text-sm text-ink-900 dark:text-paper-100">第 {v.versionNo} 稿</span><span className="font-serif text-ink-500">{v.charCount.toLocaleString()} 字</span></div>
                    <div className="mt-0.5 text-ink-500">{SOURCE_LABEL[v.source] ?? v.source}{current ? ' · 当前' : ''}</div>
                    <div className="text-ink-400">{new Date(v.createdAt).toLocaleString()}</div>
                    {!current && <Button size="sm" variant="ghost" className="mt-1.5 -ml-2" onClick={() => act(async () => { await restoreVersion(chapter.id, v.id); }, '已换回这一稿')}><RotateCcw size={12} strokeWidth={1.75} />{t.studio.restore}</Button>}
                  </li>
                );
              })}
            </ul>
          </aside>
        )}
      </div>
    </div>
  );
}

function ReviewPanel({ review }: { review: ChapterReview }) {
  const r = review.report;
  const llm = r.llm;
  const con = r.consistency;
  const conflicts = con
    ? [
        ...con.numericConflicts.map((c) => ({ tag: '数值', ...c })),
        ...con.loreConflicts.map((c) => ({ tag: '设定', ...c })),
        ...con.timelineConflicts.map((c) => ({ tag: '时间线', ...c })),
      ]
    : [];
  const oocs = llm?.ooc.filter((o) => o.verdict === 'OOC') ?? [];
  const Sec = ({ title, children }: { title: string; children: ReactNode }) => (
    <div className="mt-3">
      <div className="mb-1 font-serif text-[11px] tracking-[0.2em] text-ink-500">{title}</div>
      {children}
    </div>
  );
  return (
    <aside className="w-72 shrink-0 overflow-y-auto rounded-2xl bg-paper-0 p-4 text-xs leading-relaxed shadow-soft dark:bg-paper-900">
      <h3 className="font-serif text-sm font-semibold tracking-wide text-ink-800 dark:text-paper-100">审校报告</h3>
      <div className="mt-1 text-ink-400">{new Date(review.createdAt).toLocaleString()}</div>
      <dl className="mt-3 grid grid-cols-2 gap-x-2 gap-y-1 rounded-xl bg-paper-100 p-3 dark:bg-paper-800">
        <dt className="text-ink-500">风格分</dt><dd className={cn('font-serif', review.verdict === 'pass' ? 'text-tea-700 dark:text-tea-200' : 'text-cinnabar-700 dark:text-cinnabar-100')}>{review.styleScore} · {review.verdict === 'pass' ? '通过' : '需修订'}</dd>
        <dt className="text-ink-500">统计贴合</dt><dd className="font-serif">{r.metricScore}</dd>
        <dt className="text-ink-500">AI 味</dt><dd className="font-serif">{r.aiTellScore}</dd>
        <dt className="text-ink-500">出戏</dt><dd className="font-serif">{review.oocCount} 处</dd>
      </dl>
      {r.revisedVersionId && <p className="mt-2 text-tea-700 dark:text-tea-200">已自动定点修订一次（{r.revisionInstructions.length} 条意见）。</p>}
      {llm && (
        <Sec title="六维">
          <div className="grid grid-cols-3 gap-1 text-ink-700 dark:text-ink-200">
            {(['narrator', 'rhythm', 'imagery', 'dialogue', 'humor', 'emotion'] as const).map((d) => <span key={d}>{({ narrator: '腔调', rhythm: '节奏', imagery: '意象', dialogue: '对白', humor: '幽默', emotion: '情感' })[d]} <span className="font-serif">{llm.dimensionScores[d]}</span></span>)}
          </div>
        </Sec>
      )}
      {r.metricFindings.length > 0 && <Sec title="统计偏差"><ul className="space-y-0.5">{r.metricFindings.map((f) => <li key={f.key}>{f.hard ? <span className="text-cinnabar-600">硬 </span> : null}{f.hint}</li>)}</ul></Sec>}
      {oocs.length > 0 && <Sec title="人物出戏"><ul className="space-y-1">{oocs.map((o, i) => <li key={i}><span className="font-medium">{o.character}</span>：「{o.quote}」{o.redline && <span className="text-cinnabar-600">　红线：{o.redline}</span>}{o.why && <span className="text-ink-400">　{o.why}</span>}</li>)}</ul></Sec>}
      {conflicts.length > 0 && <Sec title="设定校对"><ul className="space-y-1">{conflicts.map((c, i) => <li key={i}><span className="text-cinnabar-600">{c.tag}</span>　「{c.quote}」{c.against && <span className="text-ink-500">　对照：{c.against}</span>}{c.why && <span className="text-ink-400">　{c.why}</span>}</li>)}</ul></Sec>}
      {con && con.addressErrors.length > 0 && <Sec title="称呼用错"><ul className="space-y-1">{con.addressErrors.map((a, i) => <li key={i}><span className="font-medium">{a.character}</span>：「{a.quote}」{a.expected && <span className="text-tea-700 dark:text-tea-200">　→ {a.expected}</span>}</li>)}</ul></Sec>}
      {llm && llm.canonConflicts.length > 0 && <Sec title="与设定矛盾"><ul className="space-y-0.5">{llm.canonConflicts.map((c, i) => <li key={i}>{c}</li>)}</ul></Sec>}
      {llm && llm.driftFindings.length > 0 && <Sec title="不像原著的地方"><ul className="space-y-1">{llm.driftFindings.map((d, i) => <li key={i}>「{d.quote}」{d.why && <span className="text-ink-500">　{d.why}</span>}{d.suggest && <span className="text-tea-700 dark:text-tea-200">　→ {d.suggest}</span>}</li>)}</ul></Sec>}
      {llm && llm.aiTells.length > 0 && <Sec title="AI 味"><ul className="space-y-0.5">{llm.aiTells.map((a, i) => <li key={i}>{a}</li>)}</ul></Sec>}
      {r.lintIssues.length > 0 && <Sec title="本地质检"><ul className="space-y-0.5">{r.lintIssues.slice(0, 10).map((i, k) => <li key={k}>{i.message}{i.quote && <span className="text-ink-400">　「{i.quote}」</span>}</li>)}</ul></Sec>}
    </aside>
  );
}
