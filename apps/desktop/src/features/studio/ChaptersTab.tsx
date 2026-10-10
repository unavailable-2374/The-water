import { FirstReadingPanel } from './FirstReadingPanel';
import { StoryOptionsButton } from './StoryOptionsPanel';
import { registerAssistantEditor } from '@/assistant/editorBridge';
import { useAssistant } from '@/assistant/runtime';
import { StreamingCursor } from '@/components/Activity';
import { jobAwaitingAction } from '@/jobs/presentation';
import { PlanReview } from './PlanReview';
import { AsyncNotice } from '@/components/data/AsyncNotice';
import { JobControls } from './JobsTab';
import { useSearchParams } from 'react-router';
import { planStyleCheck } from '@/jobs/planner';
import { listWritingCards, listPlanProposals, saveWritingCard, type PlanProposal } from '@/db/repos/writingRepo';
import { ManuscriptEditor } from './ManuscriptEditor';
import { splitChapter } from '@/db/repos/chapterStructureRepo';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { History, Maximize2, Minimize2, CheckCircle2, RotateCcw, Sparkles, Download, BookOpen, ShieldCheck, GitCompare, Pin, PinOff, Trash2, Eraser, Check, X, Undo2, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { nanoid } from 'nanoid';
import { countZh } from '@the-water/shared';
import { fmt, t } from '@/i18n';
import { Button, Dialog, EmptyState, Field, IconButton, Input, Select, cn, confirm } from '@/components/ui';
import { useAsyncData } from '@/components/data/useAsyncData';
import { toast } from '@/components/Toast';
import type { Novel } from '@/db/repos/novelsRepo';
import {
  beginRewriteSession, deleteVersion, getVersion, createVersion, listChapters, listPendingRewrites, listVersions, previewPrune, pruneVersions, resolveAllRewrites,
  resolveRewrite, restoreVersion, saveSessionEdit, sealChapterSessions, sealVersionSession, setVersionPinned,
  type Chapter, type ChapterVersion, type PendingRewrite,
} from '@/db/repos/chaptersRepo';
import { isProseStep, createJob } from '@/db/repos/jobsRepo';
import { regenerateChapter, startGeneration, startStyleCheck } from '@/novel/service';
import { dismissReviewIssue, latestReviewForChapter, type ChapterReview } from '@/db/repos/reviewsRepo';
import { mergedGenreOf } from '@/novel/genrePacks';
import { getStyleExtras } from '@/db/repos/storylineRepo';
import { recordUserEdit } from '@/db/repos/feedbackRepo';
import { lintText, type LintReport } from '@/novel/lint';
import type { StyleProfile } from '@the-water/shared';
import { kick } from '@/jobs/runner';
import { activeJobsForNovel, blockingJobForNovel, useJobs } from '@/stores/jobsStore';
import { getSetting, setSetting } from '@/db/repos/settingsRepo';
import { collectExportChapters, FORMAT_LABEL, exportNovel, type ExportFormat } from '@/novel/export';
import { diffText, sideOf, summarizeTextDiff, type DiffOp } from '@/novel/diff';
import { AUTOSAVE_DEBOUNCE_MS, DEFAULT_KEEP_VERSIONS, SESSION_IDLE_MS, shouldSealSession } from '@/novel/versionPolicy';
import { jobStatusLabel } from './JobsTab';

/** 章节状态的圆点颜色；文案统一从 `t.studio` 现取，不在模块顶层拷贝。 */
const STATUS_DOT: Record<Chapter['status'], string> = {
  planned: 'bg-paper-400', generating: 'bg-tea-500 animate-pulse', draft: 'bg-amber-500', final: 'bg-tea-600', stale: 'bg-cinnabar-500',
};
function statusLabel(status: Chapter['status']): string {
  return { planned: t.studio.planned, generating: t.studio.generating, draft: t.studio.draft, final: t.studio.final, stale: t.studio.stale }[status];
}
function sourceLabel(source: ChapterVersion['source']): string {
  return t.studio.chaptersTab.source[source] ?? source;
}
/** 从这些来源的稿子上删掉的话，会被学习层记成软负例。 */
const AI_SOURCES = new Set<ChapterVersion['source']>(['generated', 'rewritten', 'topup', 'trim']);
const STATE_CLS: Partial<Record<ChapterVersion['state'], string>> = {
  pending: 'text-amber-700 dark:text-amber-300',
  discarded: 'text-ink-400 line-through',
};
function stateLabel(state: ChapterVersion['state']): string | null {
  if (state === 'pending') return t.studio.chaptersTab.state.pending;
  if (state === 'discarded') return t.studio.chaptersTab.state.discarded;
  return null;
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
/** 「第三章」这样的中文章号。 */
const zhChapter = (n: number) => fmt(t.studio.chapterNo, { n: zhNum(n) });

interface ChapterListData { chapters: Chapter[]; pending: PendingRewrite[]; proposals: PlanProposal[] }

export function ChaptersTab({ novel }: { novel: Novel }) {
  const [params, setParams] = useSearchParams();
  const [focus, setFocus] = useState(false);
  const [tocCollapsed, setTocCollapsed] = useState(() => localStorage.getItem('water.chapterTocCollapsed') === 'true');
  const toggleToc = () => {
    const next = !tocCollapsed;
    localStorage.setItem('water.chapterTocCollapsed', String(next));
    setTocCollapsed(next);
  };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const tick = useJobs((s) => s.novelTick[novel.id] ?? 0);
  const jobs = useJobs((s) => s.jobs);
  const live = useJobs((s) => s.live);
  const active = activeJobsForNovel(jobs, novel.id)[0];
  // 禁用按钮看的是「服务层会不会拒收新任务」，与流式展示用的 active 不是一回事：
  // 失败的任务不该把整章工具栏锁死（服务层本来就肯收）。
  const blocking = blockingJobForNovel(jobs, novel.id);
  const blockingSteps=useJobs(s=>blocking?s.steps[blocking.id]:undefined);
  const blockingStep=blockingSteps?.find(s=>s.id===blocking?.progress.currentStepId);
  const waitingKind=blocking?jobAwaitingAction(blocking,blockingStep):null;
  const waitingHint=blockingStep?.kind==='commit_chapter' && blocking?.error==='改写稿已审查，等待作者采纳' ? t.studio.workflow.reviewBeforeEditing : waitingKind==='proposal'?t.studio.workflow.reviewBeforeEditing:waitingKind==='memory'?t.studio.workflow.memoryHint:t.studio.workflow.blockerHint;
  const liveText = active ? live[active.id]?.text : undefined;
  const liveStepId = active ? live[active.id]?.stepId : undefined;
  const steps = useJobs((s) => (active ? s.steps[active.id] : undefined));
  // 只有输出正文的步骤才驱动编辑器预览；JSON 类步骤即使带着 chapterId 也不显示。
  const liveChapterId = useMemo(() => {
    const st = steps?.find((x) => x.id === liveStepId);
    return st && isProseStep(st.kind) ? (st.chapterId ?? null) : null;
  }, [steps, liveStepId]);
  useEffect(() => { if (active && !steps) void useJobs.getState().loadSteps(active.id); }, [active?.id, steps]);

  const { data, error: listError, reload: reloadList } = useAsyncData<ChapterListData>(async () => {
    const [chapters, pending, proposals] = await Promise.all([listChapters(novel.id), listPendingRewrites(novel.id), listPlanProposals(novel.id)]);
    return { chapters, pending, proposals };
  }, { key: `chapters:${novel.id}:${tick}` });
  const chapters = useMemo(() => data?.chapters ?? [], [data]);
  const pending = useMemo(() => data?.pending ?? [], [data]);
  const reload = useCallback(async () => { reloadList(); }, [reloadList]);

  useEffect(() => { if (!selectedId && chapters[0]) setSelectedId(chapters[0].id); }, [chapters, selectedId]);
  const requestedChapter = params.get('chapter');
  const requestedChapterNo=params.get('chapterNo');
  useEffect(() => { const requested=chapters.find(c=>requestedChapter?c.id===requestedChapter:requestedChapterNo && c.chapterNo===Number(requestedChapterNo));if(requested)setSelectedId(requested.id); }, [requestedChapter, requestedChapterNo, chapters]);
  const selected = chapters.find((c) => c.id === selectedId) ?? null;
  const unwritten = chapters.filter((c) => !c.currentVersionId).length;
  const selectChapter = (id: string) => { setSelectedId(id); setParams(previous => { const next=new URLSearchParams(previous); next.set('chapter',id); return next; },{replace:true}); };
  if (listError || !data) return <AsyncNotice error={listError} retry={reloadList} />;

  return (
    <div className={cn("grid h-full grid-rows-[minmax(0,1fr)] bg-paper-50 dark:bg-paper-950",focus || tocCollapsed ? "grid-cols-1" : "grid-cols-[250px_minmax(0,1fr)]")}>
      <aside className={cn((focus || tocCollapsed) && "hidden", "flex flex-col border-r border-paper-300/60 bg-paper-100/60 dark:border-paper-800 dark:bg-paper-900/60")}>
        <div className="flex justify-end px-2 pt-2">
          <IconButton label={tocCollapsed ? t.studio.chaptersTab.expandToc : t.studio.chaptersTab.collapseToc} aria-expanded={!tocCollapsed} aria-controls="chapter-toc" onClick={toggleToc}>
            {tocCollapsed ? <PanelLeftOpen size={16} aria-hidden="true" /> : <PanelLeftClose size={16} aria-hidden="true" />}
          </IconButton>
        </div>
        {!tocCollapsed && <>
        <div className="px-5 pt-2 pb-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="font-serif text-base font-semibold tracking-wide text-ink-900 dark:text-paper-100">{t.studio.chaptersTab.toc}</div>
              <div className="mt-0.5 text-xs text-ink-400">{fmt(t.studio.chaptersTab.written, { done: chapters.length - unwritten, total: chapters.length })}</div>
            </div>
            <IconButton label={t.studio.chaptersTab.exportTitle} onClick={() => setExportOpen(true)}><Download size={16} strokeWidth={1.75} aria-hidden="true" /></IconButton>
          </div>
          {unwritten > 0 && !active && (
            <Button size="sm" variant="ai" className="mt-3 w-full" onClick={async () => { try { await startGeneration(novel.id); toast.success(t.studio.chaptersTab.started); } catch (e) { toast.error(errText(e)); } }}><Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />{fmt(t.studio.chaptersTab.writeRest, { n: unwritten })}</Button>
          )}
        </div>
        <ul id="chapter-toc" aria-label={t.studio.chaptersTab.tocList} className="flex-1 overflow-y-auto px-3 pb-4">
          {chapters.map((c) => {
            const isLive = liveChapterId === c.id;
            const awaiting=blocking?.status==='awaiting_review' && blockingStep?.chapterId===c.id;
            const status = isLive ? 'generating' : c.status;
            return (
              <li key={c.id}>
                <button aria-current={selectedId === c.id ? 'true' : undefined} onClick={() => selectChapter(c.id)} className={cn('mb-0.5 flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left transition', selectedId === c.id ? 'bg-paper-0 shadow-soft dark:bg-paper-800' : 'hover:bg-paper-200/60 dark:hover:bg-paper-800/60')}>
                  <span className="w-7 shrink-0 pt-0.5 font-serif text-sm text-ink-400">{zhNum(c.chapterNo)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-serif text-sm tracking-wide text-ink-900 dark:text-paper-100">{c.title || t.studio.planning.pendingTitle}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-400">
                      <span className={cn('h-1.5 w-1.5 rounded-full', awaiting?'bg-amber-500':STATUS_DOT[status])} aria-hidden="true" />{awaiting?jobStatusLabel('awaiting_review'):statusLabel(status)}
                      <span aria-hidden="true">·</span><span className="font-serif">{fmt(t.studio.chaptersTab.targetCount, { n: c.targetChars.toLocaleString() })}</span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        </>}
      </aside>
      <section className="flex min-w-0 flex-col overflow-hidden">
        {selected && <div className="shrink-0 px-6 py-2"><StoryOptionsButton novel={novel} scope={{ kind: 'chapter', id: selected.id }} onChanged={reload} /></div>}
        {blocking?.status === 'awaiting_review' && <div className="flex shrink-0 items-center gap-3 border-b border-paper-200 px-6 py-3 text-sm dark:border-paper-800"><span className="min-w-0 flex-1 text-amber-700 dark:text-amber-200">{blocking.error || t.studio.workflow.pendingReview}</span><JobControls job={blocking} /></div>}
        {data?.proposals.some(p => p.chapterId === selectedId && p.card.kind === 'scene') && <div className="max-h-[50%] shrink-0 overflow-auto p-6"><PlanReview novel={novel} cards={data.proposals.filter(p => p.chapterId === selectedId && p.card.kind === 'scene')} chapters={chapters} onResolved={reload} /></div>}
        {pending.length > 0 && <PendingRewriteBar novel={novel} pending={pending} busy={!!blocking && blocking.status !== 'awaiting_review'} onChanged={reload} onPick={selectChapter} />}
        <div className="min-h-0 flex-1 overflow-hidden">
          {selected ? <ChapterEditor onExpandToc={tocCollapsed && !focus ? toggleToc : undefined} focus={focus} setFocus={setFocus} key={selected.id} novel={novel} chapter={selected} liveRunning={active?.status === 'running'} liveText={liveChapterId === selected.id ? liveText : undefined} busy={!!blocking} busyReason={blocking?.status === 'awaiting_review' ? waitingHint : blocking ? fmt(t.studio.chaptersTab.blockedByJob, { status: jobStatusLabel(blocking.status) }) : ''} onChanged={reload} /> : <EmptyState icon={<BookOpen size={40} strokeWidth={1.25} aria-hidden="true" />} title={t.studio.chaptersTab.pickChapter} description={t.studio.chaptersTab.pickChapterDesc} />}
        </div>
      </section>
      <ExportDialog novel={novel} chapters={chapters} open={exportOpen} onClose={() => setExportOpen(false)} />
    </div>
  );
}

function ScenePlan({novelId,chapterId,tick}:{novelId:string;chapterId:string;tick:number}) {
  const [confirming,setConfirming]=useState(false);
  const {data:scenes,error,reload}=useAsyncData(()=>listWritingCards(novelId,{kind:'scene',chapterId}),{key:`sceneNavigation:${chapterId}:${tick}`});
  if (error || scenes === undefined) return <AsyncNotice error={error} retry={reload} />;
  return <div className="p-4 text-sm leading-relaxed text-ink-600 dark:text-paper-200"><h3 className="mb-3 font-semibold">{t.studio.chaptersTab.scenePlan}</h3>{scenes.length === 0 && <p>{t.studio.chaptersTab.noScenes}</p>}{scenes.map(scene=>scene.kind==='scene' && <details key={scene.id} className="my-2" open={!scene.confirmed}><summary className="cursor-pointer">{scene.data.title} · {scene.confirmed ? t.studio.workbench.confirmed:t.studio.workbench.unconfirmed}</summary><p>{scene.data.time} · {scene.data.location}</p>{(['goal','obstacle','turn','outcome'] as const).map(key=><p key={key} className="mt-1">{t.studio.workbench.fields[key]}：{scene.data[key]}</p>)}{!scene.confirmed && <Button size="sm" disabled={confirming} onClick={async()=>{setConfirming(true);try{await saveWritingCard(novelId,{kind:'scene',data:scene.data},{id:scene.id,chapterId,expectedRevision:scene.revision,confirmed:true});reload();}catch(e){toast.error(errText(e));}finally{setConfirming(false);}}}>{t.studio.workbench.save}</Button>}</details>)}</div>;
}

// ---------------------------------------------------------------------------
// 旧 / 新对比（§2.2 第 1、2 条）
// ---------------------------------------------------------------------------

/** 一栏正文：改动处按删 / 加着色，其余是原文。 */
function DiffColumn({ label, hint, ops }: { label: string; hint?: string; ops: DiffOp[] }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="font-serif text-sm tracking-wide text-ink-800 dark:text-paper-100">{label}</span>
        {hint && <span className="text-[11px] text-ink-400">{hint}</span>}
      </div>
      <div aria-label={label} className="prose-novel min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-2xl bg-paper-0 px-5 py-4 text-sm leading-relaxed text-ink-800 shadow-soft dark:bg-paper-900 dark:text-paper-100">
        {ops.length === 0 ? <span className="text-ink-400">{t.studio.chaptersTab.emptyDraft}</span> : ops.map((op, i) => (
          <span
            key={i}
            className={cn(
              op.type === 'delete' && 'bg-cinnabar-50 text-cinnabar-800 line-through decoration-cinnabar-400 dark:bg-cinnabar-700/25 dark:text-cinnabar-100',
              op.type === 'insert' && 'bg-tea-50 text-tea-800 dark:bg-tea-800/30 dark:text-tea-100',
            )}
          >{op.text}</span>
        ))}
      </div>
    </div>
  );
}

/** 两栏对比：左旧右新，改动处高亮。 */
function DiffView({ oldText, newText, oldLabel, newLabel, oldHint, newHint }: { oldText: string; newText: string; oldLabel: string; newLabel: string; oldHint?: string; newHint?: string }) {
  const ops = useMemo(() => diffText(oldText, newText), [oldText, newText]);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <p className="text-xs text-ink-500">{summarizeTextDiff(ops)}</p>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
        <DiffColumn label={oldLabel} hint={oldHint} ops={sideOf(ops, 'old')} />
        <DiffColumn label={newLabel} hint={newHint} ops={sideOf(ops, 'new')} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 待采纳的改写（§2.2 第 1、4 条）
// ---------------------------------------------------------------------------

/** 有章节等着取舍时，编辑器顶上的那条提示。 */
function PendingRewriteBar({ novel, pending, busy, onChanged, onPick }: { novel: Novel; pending: PendingRewrite[]; busy: boolean; onChanged: () => Promise<void>; onPick: (chapterId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const bulk = async (action: 'accept' | 'discard') => {
    const ok = await confirm(
      action === 'accept'
        ? { title: fmt(t.studio.chaptersTab.acceptAllTitle, { n: pending.length }), description: t.studio.chaptersTab.acceptAllDesc, confirmText: t.studio.chaptersTab.acceptAll }
        : { title: t.studio.chaptersTab.discardAllTitle, description: fmt(t.studio.chaptersTab.discardAllDesc, { n: pending.length }), confirmText: t.studio.chaptersTab.discardAllConfirm, tone: 'danger' },
    );
    if (!ok) return;
    setWorking(true);
    try {
      const n = await resolveAllRewrites(novel.id, action);
      toast.success(action === 'accept' ? fmt(t.studio.chaptersTab.accepted, { n }) : fmt(t.studio.chaptersTab.discarded, { n }));
      await onChanged();
    } catch (e) { toast.error(errText(e)); } finally { setWorking(false); }
  };
  const list = pending.slice(0, 6).map((p) => fmt(t.studio.chapterNo, { n: p.chapter.chapterNo })).join('、') + (pending.length > 6 ? t.studio.chaptersTab.pendingMore : '');
  return (
    <>
      <div role="status" className="flex flex-wrap items-center gap-2 border-b border-amber-200/70 bg-amber-50/80 px-5 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-100">
        <span>{fmt(t.studio.chaptersTab.pendingNotice, { n: pending.length, list })}</span>
        {busy && <span className="text-xs text-amber-700 dark:text-amber-200">{t.studio.chaptersTab.pendingBusy}</span>}
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="primary" disabled={working || !pending.some(p => p.latest)} onClick={() => setOpen(true)}><GitCompare size={14} strokeWidth={1.75} aria-hidden="true" />{t.studio.chaptersTab.reviewOneByOne}</Button>
          <Button size="sm" disabled={working || busy || pending.some(p => !p.latest)} onClick={() => bulk('accept')}><Check size={14} strokeWidth={1.75} aria-hidden="true" />{t.studio.chaptersTab.acceptAll}</Button>
          <Button size="sm" disabled={working || busy} onClick={() => bulk('discard')}><Undo2 size={14} strokeWidth={1.75} aria-hidden="true" />{t.studio.chaptersTab.discardAll}</Button>
        </div>
      </div>
      <RewriteReviewDialog open={open} pending={pending} busy={busy} onClose={() => setOpen(false)} onChanged={onChanged} onPick={onPick} />
    </>
  );
}

/** 逐章对比旧 / 新，一章一章决定采纳还是丢弃。 */
function RewriteReviewDialog({ open, pending, busy, onClose, onChanged, onPick }: { open: boolean; pending: PendingRewrite[]; busy: boolean; onClose: () => void; onChanged: () => Promise<void>; onPick: (chapterId: string) => void }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  useEffect(() => {
    if (!open) { setActiveId(null); return; }
    // 处理完一章就自动跳到下一章；全部处理完就自己关掉。
    if (pending.length === 0) { onClose(); return; }
    if (!activeId || !pending.some((p) => p.chapter.id === activeId)) setActiveId(pending[0]!.chapter.id);
  }, [open, pending, activeId]);

  const active = pending.find((p) => p.chapter.id === activeId) ?? null;
  const resolve = async (action: 'accept' | 'discard') => {
    if (!active) return;
    setWorking(true);
    try {
      await resolveRewrite(active.chapter.id, action);
      const n = active.chapter.chapterNo;
      toast.success(action === 'accept' ? fmt(t.studio.chaptersTab.acceptedOne, { n }) : fmt(t.studio.chaptersTab.discardedOne, { n }));
      await onChanged();
    } catch (e) { toast.error(errText(e)); } finally { setWorking(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t.studio.chaptersTab.reviewDialogTitle} subtitle={t.studio.chaptersTab.reviewDialogSubtitle} width="max-w-6xl">
      <div className="flex h-[70vh] min-h-0 gap-4">
        <ul aria-label={t.studio.chaptersTab.reviewList} className="w-44 shrink-0 space-y-1 overflow-y-auto pr-1">
          {pending.map((p) => (
            <li key={p.chapter.id}>
              <button
                aria-current={p.chapter.id === activeId ? 'true' : undefined}
                onClick={() => setActiveId(p.chapter.id)}
                className={cn('w-full rounded-xl px-3 py-2 text-left text-sm transition', p.chapter.id === activeId ? 'bg-paper-0 shadow-soft dark:bg-paper-800' : 'hover:bg-paper-100 dark:hover:bg-paper-800/60')}
              >
                <span className="block truncate font-serif text-ink-900 dark:text-paper-100">{fmt(t.studio.chapterNo, { n: p.chapter.chapterNo })}　{p.chapter.title}</span>
                <span className="mt-0.5 block text-[11px] text-ink-400">{fmt(t.studio.chaptersTab.pendingMeta, { chars: (p.latest?.charCount ?? 0).toLocaleString() })}</span>
              </button>
            </li>
          ))}
        </ul>
        {active ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
            <DiffView
              oldText={active.baseline?.content ?? ''}
              newText={active.latest?.content ?? ''}
              oldLabel={t.studio.chaptersTab.beforeRewrite}
              newLabel={t.studio.chaptersTab.afterRewrite}
              oldHint={active.baseline ? fmt(t.studio.chaptersTab.versionMeta, { no: active.baseline.versionNo, chars: active.baseline.charCount.toLocaleString() }) : undefined}
              newHint={active.latest ? fmt(t.studio.chaptersTab.versionMeta, { no: active.latest.versionNo, chars: active.latest.charCount.toLocaleString() }) : undefined}
            />
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => { onPick(active.chapter.id); onClose(); }}>{t.studio.chaptersTab.goEdit}</Button>
              <div className="ml-auto flex items-center gap-2">
                <Button size="sm" disabled={working || busy} onClick={() => resolve('discard')}><X size={14} strokeWidth={1.75} aria-hidden="true" />{t.studio.chaptersTab.discardOne}</Button>
                <Button size="sm" variant="primary" disabled={working || busy || !active.latest} onClick={() => resolve('accept')}><Check size={14} strokeWidth={1.75} aria-hidden="true" />{t.studio.chaptersTab.acceptOne}</Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-ink-400">{t.studio.chaptersTab.allResolved}</div>
        )}
      </div>
    </Dialog>
  );
}

const FORMATS: ExportFormat[] = ['txt', 'md', 'epub', 'docx'];

interface ExportMeta { author: string; license: string }

/** 导出对话框：选格式、挑章节范围、补作者与许可，元数据会写进文件里。 */
function ExportDialog({ novel, chapters, open, onClose }: { novel: Novel; chapters: Chapter[]; open: boolean; onClose: () => void }) {
  const [draftExport, setDraftExport] = useState(false);
  const { data: exportable } = useAsyncData(
    () => collectExportChapters(novel.id, draftExport),
    { key: `exportable:${novel.id}:${draftExport}:${chapters.map(c => `${c.currentVersionId}:${c.committedVersionId}`).join(',')}`, enabled: open },
  );
  const written = exportable ?? [];
  const first = written[0]?.chapterNo ?? 1;
  const last = written[written.length - 1]?.chapterNo ?? 1;
  const [format, setFormat] = useState<ExportFormat>('txt');
  const [whole, setWhole] = useState(true);
  const [from, setFrom] = useState(first);
  const [to, setTo] = useState(last);
  const [busy, setBusy] = useState(false);

  const { data: meta, setData: setMeta } = useAsyncData<ExportMeta>(async () => ({
    author: await getSetting('exportAuthor', ''),
    license: await getSetting('exportLicense', t.studio.exportDialog.defaultLicense),
  }), { key: 'exportMeta', enabled: open });
  // Only draft export includes current, unaccepted rewrites.
  const { data: pendingCount } = useAsyncData<number>(
    async () => (await listPendingRewrites(novel.id)).length,
    { key: `exportPending:${novel.id}`, enabled: open },
  );
  const author = meta?.author ?? '';
  const license = meta?.license ?? '';

  useEffect(() => { if (open) { setFrom(first); setTo(last); } }, [open, first, last]);

  const count = written.filter((c) => whole || (c.chapterNo >= from && c.chapterNo <= to)).length;
  const doExport = async () => {
    setBusy(true);
    try {
      await setSetting('exportAuthor', author);
      await setSetting('exportLicense', license);
      const path = await exportNovel(novel, format, { draft: draftExport, range: whole ? null : { from, to }, meta: { author, license } });
      if (path) { toast.success(fmt(t.studio.exportDialog.exported, { path })); onClose(); }
    } catch (e) { toast.error(errText(e)); } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t.studio.exportDialog.title} subtitle={t.studio.exportDialog.subtitle} width="max-w-md">
      <div className="space-y-4">
        {draftExport && !!pendingCount && (
          <p role="alert" className="rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            {fmt(t.studio.exportDialog.pendingWarning, { n: pendingCount })}
          </p>
        )}
<label><input type="checkbox" checked={draftExport} onChange={e => setDraftExport(e.target.checked)} /> {t.studio.workbench.draftExport}</label>
        <Field label={t.studio.exportDialog.format}>
          <Select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
            {FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}
          </Select>
        </Field>
        <Field label={t.studio.exportDialog.range} hint={written.length === 0 ? t.studio.exportDialog.rangeEmpty : fmt(t.studio.exportDialog.rangeHint, { written: written.length, first, last, count })}>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-sm text-ink-600 dark:text-ink-300">
              <input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} />{t.studio.exportDialog.whole}
            </label>
            <Input aria-label={t.studio.exportDialog.from} type="number" className="w-20" min={first} max={last} value={from} disabled={whole} onChange={(e) => setFrom(Number(e.target.value))} />
            <span className="text-ink-400" aria-hidden="true">–</span>
            <Input aria-label={t.studio.exportDialog.to} type="number" className="w-20" min={first} max={last} value={to} disabled={whole} onChange={(e) => setTo(Number(e.target.value))} />
            <span className="text-sm text-ink-400">{t.studio.exportDialog.chapterUnit}</span>
          </div>
        </Field>
        <Field label={t.studio.exportDialog.author} hint={t.studio.exportDialog.authorHint}><Input value={author} onChange={(e) => setMeta((prev) => ({ author: e.target.value, license: prev?.license ?? '' }))} placeholder={t.studio.exportDialog.authorPlaceholder} /></Field>
        <Field label={t.studio.exportDialog.license}><Input value={license} onChange={(e) => setMeta((prev) => ({ author: prev?.author ?? '', license: e.target.value }))} placeholder={t.studio.exportDialog.defaultLicense} /></Field>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button onClick={onClose}>{t.common.cancel}</Button>
        <Button variant="primary" disabled={busy || count === 0} onClick={doExport}><Download size={14} strokeWidth={1.75} aria-hidden="true" />{busy ? t.studio.exportDialog.exporting : t.studio.exportDialog.doExport}</Button>
      </div>
    </Dialog>
  );
}

function ChapterEditor({ novel, chapter, liveText, liveRunning, busy, busyReason, onChanged, focus, setFocus, onExpandToc }: { onExpandToc?: () => void; focus:boolean; setFocus:React.Dispatch<React.SetStateAction<boolean>>; novel: Novel; chapter: Chapter; liveText?: string; liveRunning: boolean; busy: boolean; busyReason: string; onChanged: () => Promise<void> }) {
  const [evidenceParams] = useSearchParams();
  const evidenceVersionId = evidenceParams.get('version');
  const evidenceFrom = Number(evidenceParams.get('from')), evidenceTo = Number(evidenceParams.get('to'));
  const { data: evidenceVersion } = useAsyncData(() => evidenceVersionId ? getVersion(evidenceVersionId) : Promise.resolve(null), { key: `story-evidence:${evidenceVersionId}`, enabled: !!evidenceVersionId });
  const [text, setText] = useState('');
  const liveEditorText = useRef(text);
  liveEditorText.current=text;
  const [dirty, setDirty] = useState(false);
  const [panel, setPanel] = useState<'review' | 'versions' | 'scenes' | null>(null);

  const showVersions = panel === 'versions';
  const showReview = panel === 'review';
  useEffect(() => {
    if (!panel) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setPanel(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [panel]);
  const [lint, setLint] = useState<LintReport | null>(null);
  const [showLint, setShowLint] = useState(false);
  const saveTimer = useRef<number | null>(null);
  const lintTimer = useRef<number | null>(null);
  const idleTimer = useRef<number | null>(null);
  /** 正开着的编辑会话：这一次编辑只占一稿，反复覆盖它（§2.2 第 3 条）。 */
  const sessionRef = useRef<{ id: string; aiBase: string | null; lastEditAt: number; text: string } | null>(null);
  /** 还没落盘的正文（离开章节时补一次，免得丢掉最后两秒）。 */
  const pendingTextRef = useRef<string | null>(null);
  /** 卸载时的收尾要读最新的摘要与定稿状态，闭包里的是第一帧的，所以留个 ref。 */
  const metaRef = useRef<{ summary: string; status: Chapter['status'] }>({ summary: '', status: chapter.status });
  const recoveryKey=`water.unsaved.${chapter.id}`;
  const [recovery,setRecovery]=useState<string|null>(()=>localStorage.getItem(recoveryKey));
  const clearRecovery=(value:string)=>{if(localStorage.getItem(recoveryKey)===value) localStorage.removeItem(recoveryKey);};
  const [selection, setSelection] = useState({ from: 0, to: 0, head: 0 });

  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const workingRef = useRef<string | null>(chapter.currentVersionId);
  const [compareId, setCompareId] = useState<string | null>(null);
  const tick = useJobs((s) => s.novelTick[novel.id] ?? 0);

  const { data: profile } = useAsyncData<StyleProfile | null>(
    async () => (await getStyleExtras(novel.id)).styleProfile,
    { key: `editorStyle:${novel.id}:${tick}` },
  );
  const { data: review } = useAsyncData<ChapterReview | null>(
    () => latestReviewForChapter(chapter.id),
    { key: `chapterReview:${chapter.id}:${chapter.currentVersionId ?? ''}:${tick}` },
  );
  const versionKey = `chapterVersion:${chapter.id}:${chapter.currentVersionId ?? ''}:${tick}`;
  const { data: loadedVersion, setData: setLoadedVersion } = useAsyncData<{key:string;value:ChapterVersion|null}>(
    async () => ({key:versionKey,value:chapter.currentVersionId ? await getVersion(chapter.currentVersionId) : null}),
    { key: versionKey },
  );
  // The data hook intentionally retains its previous value while fetching. Never
  // mark the new key synchronized using that previous version's prose.
  const version=loadedVersion?.key===versionKey ? loadedVersion.value : undefined;
  const setVersion=(updater:(previous:ChapterVersion|null|undefined)=>ChapterVersion|null)=>setLoadedVersion(previous=>({key:versionKey,value:updater(previous?.value)}));
  const { data: versions, reload: reloadVersions } = useAsyncData<ChapterVersion[]>(
    () => listVersions(chapter.id),
    { key: `chapterVersions:${chapter.id}:${tick}`, enabled: showVersions },
  );

  metaRef.current = { summary: version?.summary ?? '', status: chapter.status };
  const reviewCurrent = !!review?.valid && review.chapterVersionId === version?.id && review.contentHash === version?.contentHash && text === version?.content;

  // 换章 / 换当前稿时把编辑区重置成该版本的正文。本地保存回填不走这里，
  // 免得把作者在等保存那两秒里敲的字吞掉，所以用 ref 记住「这个 key 已经同步过了」。
  const syncedRef = useRef<string>('');
  useEffect(() => {
    if (version === undefined || syncedRef.current === versionKey) return;
    syncedRef.current = versionKey;
    if (pendingTextRef.current !== null) return;
    workingRef.current = version?.id ?? null;
    setText(version?.content ?? '');
    setDirty(false);
  }, [versionKey, version]);

  // local QC (docs/writing/lexicon/lint-rules.md + 题材层负面清单), 500ms debounce
  const genre = mergedGenreOf(novel.requirements);
  useEffect(() => {
    const val = liveText !== undefined && liveText !== '' ? liveText : text;
    if (lintTimer.current) window.clearTimeout(lintTimer.current);
    if (countZh(val) < 200) { setLint(null); return; }
    lintTimer.current = window.setTimeout(() => setLint(lintText(val, { profile: profile ?? null, genre })), 500);
    return () => { if (lintTimer.current) window.clearTimeout(lintTimer.current); };
  }, [text, liveText, profile, genre]);

  /**
   * 封版：把这一次编辑会话收尾。会话里的所有改动共用一个版本行，
   * 封版之后再动笔就另起一稿（§2.2 第 3 条）。
   * 学习层也挪到这里——一次会话只喂一次，而不是每 2 秒喂一次。
   */
  const flushAndSeal = (): void => {
    if (saveTimer.current) { window.clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (idleTimer.current) { window.clearTimeout(idleTimer.current); idleTimer.current = null; }
    const session = sessionRef.current;
    const unsaved = pendingTextRef.current;
    sessionRef.current = null;
    pendingTextRef.current = null;
    if (!session && unsaved === null) return;
    const sessionId = session?.id ?? nanoid();
    const finalText = unsaved ?? session?.text ?? '';
    saveQueue.current = saveQueue.current.catch(() => undefined).then(async () => {
      try {
        const meta = metaRef.current;
        if (unsaved !== null) { const saved=await saveSessionEdit({ chapterId: chapter.id, sessionId, content: unsaved, expectedWorkingVersionId: workingRef.current, summary: meta.summary, status: 'draft' }); workingRef.current=saved.id; setVersion(()=>saved); clearRecovery(unsaved); }
        await sealVersionSession(sessionId);
        // 学习层：作者从 AI 稿上删掉的东西算一次软负例
        if (session?.aiBase && session.aiBase !== finalText) {
          const learned = await recordUserEdit(novel.id, session.aiBase, finalText);
          if (learned.length) toast.success(fmt(t.studio.chaptersTab.learnedDislikes, { list: learned.slice(0, 5).join('、') }));
        }
      } catch (e) { if(unsaved!==null) pendingTextRef.current=unsaved; toast.error(errText(e)); }
    });
  };

  const restartIdleTimer = () => {
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => {
      const session = sessionRef.current;
      if (!session) return;
      if (shouldSealSession({ lastEditAt: session.lastEditAt, now: Date.now() })) flushAndSeal();
      else restartIdleTimer();
    }, SESSION_IDLE_MS);
  };

  // 进这一章先关掉上次遗留的会话（比如上次崩在半路），离开这一章就封版。
  useEffect(() => {
    void sealChapterSessions(chapter.id);
    return () => {
      if (shouldSealSession({ lastEditAt: sessionRef.current?.lastEditAt ?? 0, now: Date.now(), left: true })) flushAndSeal();
    };
  }, [chapter.id]);

  const scheduleSave = (val: string) => {
    if(recovery!==null) return;
    try {localStorage.setItem(recoveryKey,val);} catch(error) {toast.error(String(error));}
    setText(val); setDirty(true);
    pendingTextRef.current = val;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      if (val === (version?.content ?? '')) { setDirty(false); pendingTextRef.current = null; clearRecovery(val); return; }
      let session = sessionRef.current;
      if (!session) {
        session = { id: nanoid(), aiBase: version && AI_SOURCES.has(version.source) ? version.content : null, lastEditAt: Date.now(), text: val };
        sessionRef.current = session;
      }
      session.lastEditAt = Date.now();
      session.text = val;
      const sessionId = session.id;
      saveQueue.current = saveQueue.current.catch(() => undefined).then(async () => {
        try {
          const saved = await saveSessionEdit({ chapterId: chapter.id, sessionId, content: val, expectedWorkingVersionId: workingRef.current, status: 'draft' });
          workingRef.current = saved.id;
          if (pendingTextRef.current === val) { pendingTextRef.current = null; setDirty(false); clearRecovery(val); }
          setVersion(() => saved);
          restartIdleTimer();
          await onChanged();
        } catch (e) { toast.error(errText(e)); }
      });
    }, AUTOSAVE_DEBOUNCE_MS);
  };

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { flushAndSeal(); await saveQueue.current; if(pendingTextRef.current!==null) throw new Error(t.studio.workbench.saveFailed); await fn(); toast.success(ok); await onChanged(); } catch (e) { toast.error(errText(e)); }
  };
  const adjust = (kind: 'expand' | 'trim') => act(async () => {
    // one-off adjust job: reuse adjust_length step by temporarily pushing target
    const job = await createJob({ novelId: novel.id, type: 'regenerate_chapter', params: { chapterNo: chapter.chapterNo, adjust: kind }, providerId: null, steps: [{ kind: 'adjust_length', chapterId: chapter.id, input: { chapterNo: chapter.chapterNo, force: kind } }, ...planStyleCheck(chapter)] });
    await beginRewriteSession([chapter.id],job.id);
    kick();
    return job;
  }, kind === 'expand' ? t.studio.chaptersTab.expandQueued : t.studio.chaptersTab.trimQueued);

  const assistantFlush = useRef(async () => useAssistant.getState().context);
  assistantFlush.current = async () => {
    if(recovery!==null) throw new Error(t.studio.workbench.saveFailed);
    const captured=liveEditorText.current;
    flushAndSeal(); await saveQueue.current;
    if(pendingTextRef.current!==null || captured!==liveEditorText.current) throw new Error(t.studio.workbench.editConflict);
    const saved=await getVersion(workingRef.current);
    if((saved?.content ?? '')!==captured) throw new Error(t.studio.workbench.editConflict);
    return {...useAssistant.getState().context,novelId:novel.id,chapterId:chapter.id,
      selection:saved && selection.to>selection.from ? {from:selection.from,to:selection.to,versionId:saved.id,contentHash:saved.contentHash}:null};
  };
  useEffect(()=>registerAssistantEditor({novelId:novel.id,chapterId:chapter.id,flush:()=>assistantFlush.current()}),[novel.id,chapter.id]);
  useEffect(()=>{
    useAssistant.getState().setContext({novelId:novel.id,chapterId:chapter.id,selection:version && selection.to>selection.from?{from:selection.from,to:selection.to,versionId:version.id,contentHash:version.contentHash}:null});
  },[novel.id,chapter.id,selection.from,selection.to,version?.id,version?.contentHash]);

  const displayText = liveText !== undefined && liveText !== '' ? liveText : text;
  const count = countZh(displayText);
  const ratio = chapter.targetChars ? Math.round((count / chapter.targetChars) * 100) : 0;
  const isFinal = chapter.status === 'final';
  const versionList = versions ?? [];
  /** 按钮为什么点不动：有任务占着 > 这章还没写。灰着却不说理由，用户只会以为是坏了。 */
  const whyDisabled = (needsVersion: boolean): string | undefined =>
    busy ? busyReason : needsVersion && !version ? t.studio.chaptersTab.blockedNoVersion : undefined;

  return (
    <div className={cn("flex h-full min-w-0 flex-col", focus && "fixed inset-0 z-40 bg-paper-50 dark:bg-paper-950")}>
      <div className="flex shrink-0 flex-wrap items-start gap-2 border-b border-paper-200 px-5 py-3 dark:border-paper-800">
        <div className="min-w-0 basis-full">
          <div className="flex min-w-0 items-center gap-2">
            {onExpandToc && <IconButton label={t.studio.chaptersTab.expandToc} aria-expanded={false} onClick={onExpandToc}><PanelLeftOpen size={16} aria-hidden="true" /></IconButton>}
            <h2 className="min-w-0 truncate font-serif text-lg font-semibold tracking-wide text-ink-900 dark:text-paper-100">{zhChapter(chapter.chapterNo)}　{chapter.title}</h2>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-400">
            <span
              role="progressbar"
              aria-valuenow={ratio}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuetext={fmt(t.studio.chaptersTab.progressLabel, { count, target: chapter.targetChars, ratio })}
              className={cn('font-serif', (ratio < 88 || ratio > 120) && count > 0 && 'text-amber-700 dark:text-amber-300')}
            >{fmt(t.studio.chaptersTab.progress, { count: count.toLocaleString(), target: chapter.targetChars.toLocaleString(), ratio })}</span>
            {version && <span>{fmt(t.studio.chaptersTab.versionNo, { n: version.versionNo })} · {sourceLabel(version.source)}</span>}
            {dirty && <span className="text-tea-700 dark:text-tea-200" role="status">{t.studio.chaptersTab.saving}</span>}
            {lint && (
              <button aria-pressed={showLint} className={cn('rounded-md px-1.5 py-0.5 transition hover:bg-paper-200/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-tea-500/50 dark:hover:bg-paper-800', showLint && 'bg-paper-200/70 dark:bg-paper-800', lint.aiTellScore < 70 ? 'text-amber-700 dark:text-amber-300' : 'text-ink-500')} onClick={() => setShowLint((v) => !v)} title={t.studio.chaptersTab.lintTitle}>
                {fmt(t.studio.chaptersTab.lintSummary, { score: lint.aiTellScore, n: lint.issues.length })}
              </button>
            )}
            {review && (
              <button aria-pressed={showReview} className={cn('rounded-md px-1.5 py-0.5 transition hover:bg-paper-200/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-tea-500/50 dark:hover:bg-paper-800', showReview && 'bg-paper-200/70 dark:bg-paper-800', review.verdict === 'revise' ? 'text-cinnabar-700 dark:text-cinnabar-100' : 'text-tea-700 dark:text-tea-200')} onClick={() => setPanel(p => p === 'review' ? null : 'review')} title={t.studio.chaptersTab.reviewTitle}>
                {reviewCurrent ? fmt(t.studio.chaptersTab.reviewSummary, { score: review.styleScore, verdict: review.report.story && review.report.story.verdict!=='ready' ? t.studio.storyReview[review.report.story.verdict] : review.verdict === 'pass' ? t.studio.chaptersTab.verdictPass : t.studio.chaptersTab.verdictRevise }) : t.studio.workbench.reviewStale}
                {review.oocCount ? fmt(t.studio.chaptersTab.reviewOoc, { n: review.oocCount }) : ''}
              </button>
            )}
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center gap-1">
          <Button size="sm" onClick={() => useAssistant.getState().setOpen(true)}>{t.assistant.title}</Button>
          <Button size="sm" aria-pressed={panel === 'scenes'} onClick={() => setPanel(p => p === 'scenes' ? null : 'scenes')}>{t.studio.chaptersTab.scenePlan}</Button>
          <Button size="sm" onClick={() => setFocus(v => !v)}>{focus ? t.studio.workbench.exitFocus : t.studio.workbench.focus}</Button>
          <Button size="sm" disabled={busy || selection.from<=0 || selection.from>=text.length} onClick={()=>act(()=>splitChapter(chapter.id,selection.from),t.studio.workbench.structureChanged)}>{t.studio.workbench.splitChapter}</Button>
          <Button size="sm" variant="ghost" className="px-2" disabled={busy || !version} title={whyDisabled(true) ?? t.studio.expand} aria-label={t.studio.expand} onClick={() => adjust('expand')}><Maximize2 size={16} strokeWidth={1.75} aria-hidden="true" /></Button>
          <Button size="sm" variant="ghost" className="px-2" disabled={busy || !version} title={whyDisabled(true) ?? t.studio.trim} aria-label={t.studio.trim} onClick={() => adjust('trim')}><Minimize2 size={16} strokeWidth={1.75} aria-hidden="true" /></Button>
          <Button size="sm" variant="ghost" className={cn('px-2', isFinal && 'text-tea-700 dark:text-tea-200')} disabled={busy || !version || isFinal} title={whyDisabled(true) ?? (isFinal ? t.studio.final : t.studio.finalize)} aria-label={isFinal ? t.studio.final : t.studio.finalize} onClick={() => act(() => startStyleCheck(novel.id, chapter.chapterNo), t.studio.chaptersTab.styleCheckQueued)}><CheckCircle2 size={16} strokeWidth={1.75} aria-hidden="true" /></Button>
          <Button size="sm" variant="ghost" className={cn('px-2', showVersions && 'bg-paper-200/70 text-ink-900 dark:bg-paper-800')} title={t.studio.versions} aria-label={t.studio.versions} aria-pressed={showVersions} onClick={() => setPanel(p => p === 'versions' ? null : 'versions')}><History size={16} strokeWidth={1.75} aria-hidden="true" /></Button>
          <Button size="sm" variant="ghost" className="px-2" disabled={busy || !version} title={whyDisabled(true) ?? t.studio.chaptersTab.styleCheckTitle} aria-label={t.studio.chaptersTab.styleCheckTitle} onClick={() => act(() => startStyleCheck(novel.id, chapter.chapterNo), t.studio.chaptersTab.styleCheckQueued)}><ShieldCheck size={16} strokeWidth={1.75} aria-hidden="true" /></Button>
          <Button size="sm" variant="ai" className="ml-2" disabled={busy} title={whyDisabled(false)} onClick={() => act(() => regenerateChapter(novel.id, chapter.chapterNo), t.studio.chaptersTab.regenerateQueued)}><Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />{t.studio.chaptersTab.regenerate}</Button>
        </div>
      </div>
      {recovery!==null && <div className="mx-8 mb-3 rounded-xl border border-amber-300 p-3"><p>{t.studio.workbench.recovery}</p><pre className="my-2 max-h-36 overflow-auto whitespace-pre-wrap text-sm">{recovery}</pre><Button onClick={()=>act(async()=>{const saved=await createVersion({chapterId:chapter.id,content:recovery,source:'user_edit',expectedWorkingVersionId:workingRef.current});workingRef.current=saved.id;setVersion(()=>saved);setText(recovery);clearRecovery(recovery);setRecovery(null);},t.studio.workbench.working)}>{t.studio.workbench.restoreCandidate}</Button><Button onClick={()=>{clearRecovery(recovery);setRecovery(null);}}>{t.studio.workbench.discard}</Button></div>}
      {evidenceVersion && evidenceVersion.chapterId === chapter.id && evidenceVersionId !== version?.id && <aside className="mx-5 my-2 rounded border border-amber-400 p-3 text-sm"><p>{t.storyWorkspace.stale}</p><blockquote className="mt-2 whitespace-pre-wrap">{evidenceVersion.content.slice(evidenceFrom,evidenceTo)}</blockquote></aside>}
      {busy && <div role="status" className="shrink-0 border-b border-amber-200/60 bg-amber-50 px-5 py-1.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{busyReason}</div>}
      {chapter.status === 'stale' && chapter.staleReasons.length > 0 && <div role="status" className="mx-8 mb-2 rounded-xl bg-cinnabar-50 px-4 py-2 text-xs leading-relaxed text-cinnabar-700 dark:bg-cinnabar-700/20 dark:text-cinnabar-100">{fmt(t.studio.chaptersTab.staleNotice, { reasons: chapter.staleReasons.join('；') })}</div>}
      {chapter.goal && <details className="shrink-0 border-b border-paper-200 px-5 py-1.5 text-xs text-ink-500 dark:border-paper-800"><summary className="w-fit cursor-pointer">{t.studio.chaptersTab.chapterGoalTitle}</summary><p className="max-h-28 overflow-auto py-2 leading-relaxed">{chapter.goal}</p></details>}
      {showLint && lint && (
        <div className="mx-8 mb-3 max-h-40 overflow-y-auto rounded-xl bg-paper-100 px-4 py-2 text-xs leading-relaxed text-ink-700 dark:bg-paper-800 dark:text-ink-200">
          {lint.issues.length === 0 && <span className="text-ink-400">{t.studio.chaptersTab.lintClean}</span>}
          <ul className="space-y-0.5">
            {lint.issues.slice(0, 30).map((i, k) => (
              <li key={k} className="flex gap-2"><span className={cn('shrink-0 font-serif', i.severity === 'block' ? 'text-cinnabar-600' : 'text-amber-600')}>{i.severity === 'block' ? t.studio.chaptersTab.lintBlock : t.studio.chaptersTab.lintWarn}</span><span>{i.message}{i.quote && <span className="text-ink-400">　「{i.quote}」</span>}</span></li>
            ))}
          </ul>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 px-4 py-3">
        <div className="paper-texture mx-auto flex h-full min-w-0 max-w-5xl flex-1 flex-col rounded-2xl bg-paper-0 shadow-soft dark:bg-paper-900">
          {liveText !== undefined && liveText !== '' ? (
            <div aria-live="polite" aria-label={t.studio.chaptersTab.manuscript} className="prose-novel flex-1 overflow-y-auto whitespace-pre-wrap px-[clamp(20px,4vw,56px)] py-6 text-ink-900 dark:text-paper-100">{liveText}{liveRunning && <StreamingCursor />}</div>
          ) : (
            <ManuscriptEditor focusRange={evidenceVersionId === version?.id && text === version?.content && Number.isInteger(evidenceFrom) && Number.isInteger(evidenceTo) ? {from:evidenceFrom,to:evidenceTo}:undefined} readOnly={liveRunning || recovery!==null} label={t.studio.chaptersTab.manuscript} value={text} onChange={scheduleSave} onSelection={setSelection} issues={reviewCurrent ? review?.report.narrative : undefined} />
          )}
        </div>
        {panel === 'scenes' && <div className="chapter-tool-panel"><div className="flex justify-end p-2"><IconButton label={t.common.close} onClick={() => setPanel(null)}><X size={16} /></IconButton></div><ScenePlan novelId={novel.id} chapterId={chapter.id} tick={tick} /></div>}
        {showReview && review && <div className="chapter-tool-panel"><div className="flex justify-end p-2"><IconButton label={t.common.close} onClick={() => setPanel(null)}><X size={16} /></IconButton></div><ReviewPanel review={review} /></div>}
        {showVersions && (
          <div className="chapter-tool-panel"><div className="flex justify-end p-2"><IconButton label={t.common.close} onClick={() => setPanel(null)}><X size={16} /></IconButton></div><aside className="w-72 shrink-0 overflow-y-auto rounded-2xl bg-paper-0 p-4 text-xs shadow-soft dark:bg-paper-900">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h3 className="font-serif text-sm font-semibold tracking-wide text-ink-800 dark:text-paper-100">{t.studio.versions}</h3>
              <button
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-ink-500 transition hover:bg-paper-200/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-tea-500/50 dark:hover:bg-paper-800"
                title={fmt(t.studio.chaptersTab.pruneTitle, { n: DEFAULT_KEEP_VERSIONS })}
                onClick={async () => {
                  const n = await previewPrune(chapter.id, DEFAULT_KEEP_VERSIONS);
                  if (n === 0) { toast.info(fmt(t.studio.chaptersTab.pruneNothing, { n: DEFAULT_KEEP_VERSIONS })); return; }
                  const ok = await confirm({ title: fmt(t.studio.chaptersTab.pruneConfirmTitle, { n }), description: fmt(t.studio.chaptersTab.pruneConfirmDesc, { keep: DEFAULT_KEEP_VERSIONS }), confirmText: t.studio.chaptersTab.pruneConfirm, tone: 'danger' });
                  if (!ok) return;
                  await act(async () => { await pruneVersions(chapter.id, DEFAULT_KEEP_VERSIONS); reloadVersions(); }, fmt(t.studio.chaptersTab.pruned, { n }));
                }}
              ><Eraser size={12} strokeWidth={1.75} aria-hidden="true" />{t.studio.chaptersTab.prune}</button>
            </div>
            <ul aria-label={t.studio.chaptersTab.versionList} className="space-y-2">
              {versionList.map((v) => {
                const current = v.id === chapter.currentVersionId;
                const badge = stateLabel(v.state);
                return (
                  <li key={v.id} className={cn('rounded-xl p-3', current ? 'bg-tea-50 ring-1 ring-tea-200 dark:bg-tea-800/30 dark:ring-tea-800' : 'bg-paper-100 dark:bg-paper-800')}>
                    <div className="flex items-baseline justify-between"><span className="font-serif text-sm text-ink-900 dark:text-paper-100">{fmt(t.studio.chaptersTab.versionNo, { n: v.versionNo })}</span><span className="font-serif text-ink-500">{fmt(t.studio.chaptersTab.charCount, { n: v.charCount.toLocaleString() })}</span></div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-ink-500">
                      <span>{sourceLabel(v.source)}</span>
                      {current && <span>· {t.studio.chaptersTab.isCurrent}</span>}
                      {badge && <span className={STATE_CLS[v.state]}>· {badge}</span>}
                      {v.pinned && <span className="text-tea-700 dark:text-tea-200">· {t.studio.chaptersTab.isPinned}</span>}
                      {v.sessionId && <span className="text-amber-700 dark:text-amber-300">· {t.studio.chaptersTab.isEditing}</span>}
                    </div>
                    <div className="text-ink-400">{new Date(v.updatedAt).toLocaleString()}</div>
                    <div className="mt-1.5 -ml-2 flex flex-wrap items-center gap-0.5">
                      {!current && (
                        <Button size="sm" variant="ghost" className="px-1.5" title={t.studio.chaptersTab.compareTitle} onClick={() => setCompareId(v.id)}><GitCompare size={12} strokeWidth={1.75} aria-hidden="true" />{t.studio.chaptersTab.compare}</Button>
                      )}
                      {!current && <Button size="sm" variant="ghost" className="px-1.5" onClick={() => act(async () => { await restoreVersion(chapter.id, v.id); reloadVersions(); }, t.studio.chaptersTab.restored)}><RotateCcw size={12} strokeWidth={1.75} aria-hidden="true" />{t.studio.restore}</Button>}
                      <IconButton
                        label={v.pinned ? t.studio.chaptersTab.unpinTitle : t.studio.chaptersTab.pinTitle}
                        className={cn('p-1', v.pinned && 'text-tea-700 dark:text-tea-200')}
                        onClick={() => act(async () => { await setVersionPinned(v.id, !v.pinned); reloadVersions(); }, v.pinned ? t.studio.chaptersTab.unpinned : t.studio.chaptersTab.pinned)}
                      >
                        {v.pinned ? <PinOff size={12} strokeWidth={1.75} aria-hidden="true" /> : <Pin size={12} strokeWidth={1.75} aria-hidden="true" />}
                      </IconButton>
                      {!current && (
                        <IconButton
                          label={t.studio.chaptersTab.deleteVersionTitle}
                          className="p-1 text-cinnabar-600 dark:text-cinnabar-300"
                          onClick={async () => {
                            const ok = await confirm({ title: fmt(t.studio.chaptersTab.deleteVersionConfirmTitle, { n: v.versionNo }), description: t.studio.chaptersTab.deleteVersionConfirmDesc, confirmText: t.common.delete, tone: 'danger' });
                            if (!ok) return;
                            await act(async () => { await deleteVersion(v.id); reloadVersions(); }, t.studio.chaptersTab.versionDeleted);
                          }}
                        ><Trash2 size={12} strokeWidth={1.75} aria-hidden="true" /></IconButton>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </aside></div>
        )}
      </div>
      {/* 版本间文本 diff（§2.2 第 2 条） */}
      <Dialog open={!!compareId} onClose={() => setCompareId(null)} title={t.studio.chaptersTab.diffTitle} subtitle={t.studio.chaptersTab.diffSubtitle} width="max-w-6xl">
        <div className="flex h-[70vh] min-h-0 flex-col">
          {(() => {
            const older = versionList.find((v) => v.id === compareId) ?? null;
            if (!older) return <div className="flex flex-1 items-center justify-center text-sm text-ink-400">{t.studio.chaptersTab.diffGone}</div>;
            return (
              <DiffView
                oldText={older.content}
                newText={version?.content ?? ''}
                oldLabel={fmt(t.studio.chaptersTab.versionNo, { n: older.versionNo })}
                newLabel={version ? fmt(t.studio.chaptersTab.versionCurrent, { n: version.versionNo }) : t.studio.chaptersTab.currentText}
                oldHint={`${sourceLabel(older.source)} · ${fmt(t.studio.chaptersTab.charCount, { n: older.charCount.toLocaleString() })}`}
                newHint={version ? `${sourceLabel(version.source)} · ${fmt(t.studio.chaptersTab.charCount, { n: version.charCount.toLocaleString() })}` : undefined}
              />
            );
          })()}
        </div>
      </Dialog>
    </div>
  );
}

function ReviewPanel({ review }: { review: ChapterReview }) {
  const [reasons, setReasons] = useState<Record<string,string>>({});
  const [resolved, setResolved] = useState<string[]>([]);
  const r = review.report;
  const llm = r.llm;
  const con = r.consistency;
  const conflicts = con
    ? [
        ...con.numericConflicts.map((c) => ({ tag: t.studio.reviewPanel.conflictNumeric, ...c })),
        ...con.loreConflicts.map((c) => ({ tag: t.studio.reviewPanel.conflictLore, ...c })),
        ...con.timelineConflicts.map((c) => ({ tag: t.studio.reviewPanel.conflictTimeline, ...c })),
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
    <aside aria-label={t.studio.reviewPanel.title} className="w-72 shrink-0 overflow-y-auto rounded-2xl bg-paper-0 p-4 text-xs leading-relaxed shadow-soft dark:bg-paper-900">
      <h3 className="font-serif text-sm font-semibold tracking-wide text-ink-800 dark:text-paper-100">{t.studio.reviewPanel.title}</h3>
      <div className="mt-1 text-ink-400">{new Date(review.createdAt).toLocaleString()}</div>
      {r.firstReading && <FirstReadingPanel reading={r.firstReading} />}
      {!!r.readerAlignment?.length && <Sec title={t.studio.firstReading.alignment}>{r.readerAlignment.map((item, i) => <div key={i} className="my-2"><strong>{t.studio.firstReading[item.status]}</strong><p>{item.authorIntent} → {item.readerInference}</p><p>{item.reason}</p><p>{item.suggestion}</p></div>)}</Sec>}
      <Sec title={t.studio.lengthReview.title}>
        {r.lengthReview ? <div className="space-y-2"><strong>{t.studio.lengthReview[r.lengthReview.action]}</strong><p>{r.lengthReview.reason}</p>{r.lengthReview.actions.map((action,index) => { const issue=r.narrative?.find(item=>item.id===action.issueId); return issue ? <div key={index}><strong>{t.studio.lengthReview[action.action]}</strong><blockquote>「{issue.evidence.quote}」</blockquote><p>{issue.basis}</p><p>{issue.suggestion}</p></div> : null; })}</div> : <p>{t.studio.lengthReview.legacy}</p>}
      </Sec>
      <Sec title={t.studio.storyReview.title}>
        {r.story ? <div className="space-y-2">
          <strong>{t.studio.storyReview[r.story.verdict]}</strong><p>{r.story.readingFocus}</p><p>{r.story.reason}</p>
          <p className="font-semibold">{t.studio.storyReview.changes}</p>
          {r.story.changes.map((change,i)=><div key={i}><p>{change.before} → {change.after}</p><blockquote>「{change.evidence.quote}」</blockquote></div>)}
          <p className="font-semibold">{t.studio.storyReview.expectations}</p>
          {r.story.expectations.map((expectation,i)=><div key={i}><strong>{expectation.question} · {t.studio.storyReview[expectation.status]}</strong><p>{expectation.response}</p><blockquote>「{expectation.evidence.quote}」</blockquote></div>)}
          {r.story.nextInterest && <p>{t.studio.storyReview.nextInterest}：{r.story.nextInterest}</p>}
        </div> : <p>{t.studio.storyReview.legacy}</p>}
      </Sec>
      <dl className="mt-3 grid grid-cols-2 gap-x-2 gap-y-1 rounded-xl bg-paper-100 p-3 dark:bg-paper-800">
        <dt className="text-ink-500">{t.studio.reviewPanel.styleScore}</dt><dd className={cn('font-serif', review.verdict === 'pass' ? 'text-tea-700 dark:text-tea-200' : 'text-cinnabar-700 dark:text-cinnabar-100')}>{review.styleScore} · {review.report.story && review.report.story.verdict!=='ready' ? t.studio.storyReview[review.report.story.verdict] : review.verdict === 'pass' ? t.studio.chaptersTab.verdictPass : t.studio.chaptersTab.verdictRevise}</dd>
        <dt className="text-ink-500">{t.studio.reviewPanel.metricScore}</dt><dd className="font-serif">{r.metricScore}</dd>
        <dt className="text-ink-500">{t.studio.reviewPanel.aiTell}</dt><dd className="font-serif">{r.aiTellScore}</dd>
        <dt className="text-ink-500">{t.studio.reviewPanel.ooc}</dt><dd className="font-serif">{fmt(t.studio.reviewPanel.oocCount, { n: review.oocCount })}</dd>
      </dl>
      {r.narrative?.map(issue => <section className="my-3 border-t border-paper-300 pt-3" key={issue.id}><strong>{issue.category} · {issue.severity}</strong><blockquote>「{issue.evidence.quote}」</blockquote><p>{issue.evidence.from}–{issue.evidence.to} · {issue.basis}</p><p>{issue.suggestion}</p>{issue.severity === 'block' && !resolved.includes(issue.id) && <><Input aria-label={t.studio.workbench.reason} value={reasons[issue.id] ?? ''} onChange={e => setReasons(v => ({...v,[issue.id]:e.target.value}))}/><Button size="sm" disabled={!reasons[issue.id]?.trim()} onClick={async () => { try { await dismissReviewIssue(review.id,issue.id,reasons[issue.id]!); setResolved(v => [...v,issue.id]); } catch(e) { toast.error(String(e)); } }}>{t.studio.workbench.dismiss}</Button></>}</section>)}
      {r.revisedVersionId && <p className="mt-2 text-tea-700 dark:text-tea-200">{fmt(t.studio.reviewPanel.revised, { n: r.revisionInstructions.length })}</p>}
      {llm && (
        <Sec title={t.studio.reviewPanel.dimensions}>
          <div className="grid grid-cols-3 gap-1 text-ink-700 dark:text-ink-200">
            {(['narrator', 'rhythm', 'imagery', 'dialogue', 'humor', 'emotion'] as const).map((d) => <span key={d}>{t.studio.reviewPanel.dim[d]} <span className="font-serif">{llm.dimensionScores[d]}</span></span>)}
          </div>
        </Sec>
      )}
      {r.metricFindings.length > 0 && <Sec title={t.studio.reviewPanel.metricFindings}><ul className="space-y-0.5">{r.metricFindings.map((f) => <li key={f.key}>{f.hard ? <span className="text-cinnabar-600">{t.studio.reviewPanel.hard}</span> : null}{f.hint}</li>)}</ul></Sec>}
      {oocs.length > 0 && <Sec title={t.studio.reviewPanel.oocSection}><ul className="space-y-1">{oocs.map((o, i) => <li key={i}><span className="font-medium">{o.character}</span>：「{o.quote}」{o.redline && <span className="text-cinnabar-600">{fmt(t.studio.reviewPanel.redline, { text: o.redline })}</span>}{o.why && <span className="text-ink-400">　{o.why}</span>}</li>)}</ul></Sec>}
      {conflicts.length > 0 && <Sec title={t.studio.reviewPanel.canonSection}><ul className="space-y-1">{conflicts.map((c, i) => <li key={i}><span className="text-cinnabar-600">{c.tag}</span>　「{c.quote}」{c.against && <span className="text-ink-500">{fmt(t.studio.reviewPanel.against, { text: c.against })}</span>}{c.why && <span className="text-ink-400">　{c.why}</span>}</li>)}</ul></Sec>}
      {con && con.addressErrors.length > 0 && <Sec title={t.studio.reviewPanel.addressSection}><ul className="space-y-1">{con.addressErrors.map((a, i) => <li key={i}><span className="font-medium">{a.character}</span>：「{a.quote}」{a.expected && <span className="text-tea-700 dark:text-tea-200">　→ {a.expected}</span>}</li>)}</ul></Sec>}
      {llm && llm.canonConflicts.length > 0 && <Sec title={t.studio.reviewPanel.canonConflicts}><ul className="space-y-0.5">{llm.canonConflicts.map((c, i) => <li key={i}>{c}</li>)}</ul></Sec>}
      {llm && llm.driftFindings.length > 0 && <Sec title={t.studio.reviewPanel.driftSection}><ul className="space-y-1">{llm.driftFindings.map((d, i) => <li key={i}>「{d.quote}」{d.why && <span className="text-ink-500">　{d.why}</span>}{d.suggest && <span className="text-tea-700 dark:text-tea-200">　→ {d.suggest}</span>}</li>)}</ul></Sec>}
      {llm && llm.aiTells.length > 0 && <Sec title={t.studio.reviewPanel.aiTellSection}><ul className="space-y-0.5">{llm.aiTells.map((a, i) => <li key={i}>{a}</li>)}</ul></Sec>}
      {r.lintIssues.length > 0 && <Sec title={t.studio.reviewPanel.lintSection}><ul className="space-y-0.5">{r.lintIssues.slice(0, 10).map((i, k) => <li key={k}>{i.message}{i.quote && <span className="text-ink-400">　「{i.quote}」</span>}</li>)}</ul></Sec>}
    </aside>
  );
}
