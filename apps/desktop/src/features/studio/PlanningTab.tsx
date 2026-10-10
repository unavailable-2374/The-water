import { inspectCurrentOutline } from '@/novel/outlineReview';
import { StoryOptionsButton } from './StoryOptionsPanel';
import { generateStoryOptionPlan } from '@/novel/storyOptions';
import { ActivityStatus } from '@/components/Activity';
import { canSupplementPlan } from '@/jobs/planningAdmission';
import { AsyncNotice } from '@/components/data/AsyncNotice';
import { PlanReview } from './PlanReview';
import { listDocumentPlans, type DocumentPlanProposal } from '@/db/repos/planProposalsRepo';
import { isJobWorking, isJobTransitioning, jobActivityMessage } from '@/jobs/presentation';
import { docTypeGuide } from '@/novel/docTypes';
import { loadStyleCheckConfig } from '@/novel/config';
import { listWritingCards } from '@/db/repos/writingRepo';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Sparkles, Play, RefreshCw, CheckCircle2, Circle, ShieldAlert } from 'lucide-react';
import { fmt, t } from '@/i18n';
import { Badge, Button, Card, SectionTitle, Spinner, cn } from '@/components/ui';
import { useAsyncData } from '@/components/data/useAsyncData';
import { toast } from '@/components/Toast';
import type { Novel } from '@/db/repos/novelsRepo';
import { listChapters, type Chapter } from '@/db/repos/chaptersRepo';
import { listArcs, listBeats, listCharacters, listSettings } from '@/db/repos/storylineRepo';
import { latestReviewByChapter, type ChapterReview } from '@/db/repos/reviewsRepo';
import {
  getNovelProviders, setNovelProviders, startChapterTable, startGeneration, startOutline, startStyleCheck, wantsStyleCheck,
} from '@/novel/service';
import { estimateGeneration, estimatePlanning, planningCallCount } from '@/novel/pricing';
import { planChapterCount } from '@/novel/wordBudget';
import { useJobs, blockingJobForNovel } from '@/stores/jobsStore';
import { JobControls } from './JobsTab';
import type { StepProviderMap } from '@/jobs/purposes';
import { CostEstimateLine, previewCostForNovel, UsageCards, type CostPreview } from './UsagePanel';
import { ModelPurposePicker } from './ModelPicker';
import type { Arc, Beat, Character, Setting } from '@the-water/shared';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface PlanData {
  chars: Character[];
  settings: Setting[];
  arcs: Arc[];
  beats: Beat[];
  chapters: Chapter[];
  reviews: Map<string, ChapterReview>;
  proposals: DocumentPlanProposal[];
}

const EMPTY_PLAN: PlanData = { chars: [], settings: [], arcs: [], beats: [], chapters: [], reviews: new Map(), proposals: [] };

/**
 * 规划流程：大纲 → （审阅）→ 章节表 → （审阅）→ 开工。
 * 发起、进度和候选审阅在同一页；只有作者采纳后才解锁下一步。
 */
export function PlanningTab({ novel, onChanged }: { novel: Novel; onChanged: () => Promise<void> }) {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const directionStarted = useRef<string | null>(null);
  useEffect(() => {
    const id = params.get('direction');
    if (!id || directionStarted.current === id) return;
    directionStarted.current = id;
    void generateStoryOptionPlan(novel.id, id).then(onChanged).catch(e => toast.error(String(e)));
  }, [novel.id, params]);
  const taskLock = useRef(false);
  const reviewRef = useRef<HTMLDivElement>(null);
  const showReview = () => reviewRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });

  const allJobs = useJobs((s) => s.jobs);
  // 这本书当前在跑的任务（规划任务与写作任务共用这块进度显示）。
  const activeJob = useMemo(
    () => blockingJobForNovel(allJobs, novel.id),
    [allJobs, novel.id],
  );
  const stepsByJob = useJobs((s) => s.steps);
  const latestJob = useMemo(() => Object.values(allJobs).filter(j => j.novelId === novel.id).sort((a,b) => b.createdAt-a.createdAt)[0], [allJobs,novel.id]);
  const activeKind = useMemo(() => {
    const steps = activeJob ? stepsByJob[activeJob.id] : undefined;
    return steps?.find((s) => s.id === activeJob?.progress.currentStepId)?.kind ?? null;
  }, [activeJob?.id, activeJob?.progress.currentStepId, stepsByJob]);
  useEffect(() => { if (activeJob) void useJobs.getState().loadSteps(activeJob.id); }, [activeJob?.id, activeJob?.progress.done]);

  const tick = useJobs((s) => s.novelTick[novel.id] ?? 0);
  const { data: plan, error: planError, reload: reloadPlan } = useAsyncData<PlanData>(async () => {
    const [chars, settings, arcs, beats, chapters, reviews, proposals] = await Promise.all([
      listCharacters(novel.id), listSettings(novel.id), listArcs(novel.id), listBeats(novel.id), listChapters(novel.id), latestReviewByChapter(novel.id), listDocumentPlans(novel.id),
    ]);
    return { chars, settings, arcs, beats, chapters, reviews, proposals };
  }, { key: `plan:${novel.id}:${novel.meta.outlineDone}:${novel.meta.tableDone}:${tick}` });
  const { chars, settings, arcs, beats, chapters, reviews } = plan ?? EMPTY_PLAN;

  const { data: providerIds, setData: setProviderIds } = useAsyncData<StepProviderMap>(
    () => getNovelProviders(novel.id), { key: `novelProviders:${novel.id}` },
  );

  // 费用预估（§2.1 第 3 条）：模型或章节表一变就重算。
  const costKey = `${novel.id}:${novel.targetChars}:${chapters.length}:${JSON.stringify(providerIds ?? {})}`;
  const { data: genCost } = useAsyncData<CostPreview>(async () => {
    const styleCheck = await wantsStyleCheck(novel.id);
    const list = chapters.length ? chapters : Array.from({ length: planChapterCount(novel.targetChars,{docType:novel.requirements.docType}) }, () => ({ targetChars: Math.round(novel.targetChars / planChapterCount(novel.targetChars,{docType:novel.requirements.docType})) }));
    return previewCostForNovel(novel.id, estimateGeneration(await Promise.all(list.map(async c=>({...c,sceneCount:'id' in c ? Math.max(1,(await listWritingCards(novel.id,{kind:'scene',chapterId:String(c.id),confirmed:true})).length):undefined}))), { styleCheck,maxRevisions:(await loadStyleCheckConfig()).maxRevisions }));
  }, { key: `genCost:${costKey}` });
  const { data: planCost } = useAsyncData<CostPreview>(async () => {
    const planning = estimatePlanning(planChapterCount(novel.targetChars,{docType:novel.requirements.docType}));
    const calls = planningCallCount(planChapterCount(novel.targetChars,{docType:novel.requirements.docType}));
    return previewCostForNovel(novel.id, { writing: { inputTokens: 0, outputTokens: 0 }, auxiliary: planning,byPurpose:{planning},calls:{planning:calls},minimumCalls:calls,maximumCalls:calls });
  }, { key: `planCost:${costKey}` });

  const saveProviders = async (next: StepProviderMap) => {
    setProviderIds(() => next);
    await setNovelProviders(novel.id, next);
  };

  const start = async (label: string, fn: () => Promise<string>): Promise<boolean> => {
    if (taskLock.current) return false;
    taskLock.current = true;
    setBusy(true);
    try {
      await fn();
      toast.success(label);
      await onChanged();
      return true;
    } catch (e) {
      toast.error(errMsg(e));
      return false;
    } finally {
      setBusy(false);
      taskLock.current = false;
    }
  };

  const doOutline = () => start(t.studio.planning.outlineStarted, () => startOutline(novel.id));
  const doTable = () => start(t.studio.planning.tableStarted,()=>startChapterTable(novel.id,{fillMissing:chapters.some(c=>!c.title.trim() || !c.goal.trim())}));
  // §2.3 第 3 条：跑满修订轮数仍未达标的章节在这里标出来，可以单章重审。
  const failed = chapters.filter((c) => reviews.get(c.id)?.verdict === 'revise');
  const recheck = (chapterNo: number) => start(fmt(t.studio.planning.recheckQueued, { n: chapterNo }), () => startStyleCheck(novel.id, chapterNo));

  const doStart = async () => {
    if (await start(t.studio.chaptersTab.started, () => startGeneration(novel.id))) nav(`/studio/${novel.id}/chapters`);
  };

  // The wizard starts only the outline; confirmed stages still require author review.
  useEffect(() => {
    if (params.get('auto') === '1' && plan && !plan.proposals.length && !novel.meta.outlineDone && !busy && !activeJob) {
      setParams({});
      void doOutline();
    }
  }, [params, plan, novel.meta.outlineDone, busy, activeJob?.id]);

  const totalTarget = chapters.reduce((s, c) => s + c.targetChars, 0);
  const outlineDone = novel.meta.outlineDone;
  const tableDone = novel.meta.tableDone;
  const proposals = plan?.proposals ?? [];
  const waitingOutline = proposals.some(p => !p.meta.outlineReviewOnly && p.meta.outlineDone === true && p.meta.tableDone !== true);
  const waitingTable = proposals.some(p => p.meta.tableDone === true);
  const running = !!activeJob || busy || proposals.length > 0;
  const missingPlan = chapters.some(c => !c.title.trim() || !c.goal.trim());
  const tableBlocked = busy || proposals.length > 0 || (!!activeJob && !((missingPlan || novel.meta.storyOptionStage === 'outline' && outlineDone && !tableDone) && canSupplementPlan(Object.values(allJobs).filter(j => j.novelId === novel.id))));
  if (planError || !plan) return <AsyncNotice error={planError} retry={reloadPlan} />;

  return (
    <div className="grid h-full grid-rows-[minmax(0,1fr)] grid-cols-[1fr_340px] bg-paper-50 dark:bg-paper-950">
      <div className="overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-8">
          <div className="mb-5 flex flex-wrap gap-2"><StoryOptionsButton novel={novel} scope={{ kind: 'work', id: novel.id }} onChanged={onChanged} />{docTypeGuide(novel.requirements.docType).fiction && <Button disabled={busy || !arcs.length} onClick={() => void start(t.outlineReview.title, async () => { try { return await inspectCurrentOutline(novel.id); } finally { reloadPlan(); } })}>{t.outlineReview.inspectCurrent}</Button>}</div>
          {proposals.length > 0 && <div ref={reviewRef} className="mb-8"><PlanReview novel={novel} documents={proposals} chapters={chapters} onResolved={onChanged} /></div>}
          <section className="mb-8">
            <SectionTitle>{t.studio.planning.premise}</SectionTitle>
            <Card className="paper-texture">
              <p className="whitespace-pre-wrap font-serif text-[15px] leading-[1.9] text-ink-800 dark:text-paper-100">{novel.premise || t.studio.planning.premiseEmpty}</p>
            </Card>
          </section>

          {outlineDone && (
            <section className="mb-8 space-y-6">
              <div>
                <SectionTitle action={<span className="text-xs text-ink-400">{t.studio.planning.outlineHint}</span>}>{t.studio.planning.outline}</SectionTitle>
                {novel.meta.logline && <p className="font-serif text-base leading-relaxed tracking-wide text-ink-700 dark:text-ink-200">{novel.meta.logline}</p>}
              </div>

              <Group title={t.studio.characters} count={chars.length}>
                <ul aria-label={t.studio.characters} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {chars.map((c) => (
                    <li key={c.id} className="rounded-2xl bg-paper-0 p-4 shadow-soft dark:bg-paper-900">
                      <div className="font-serif text-base font-semibold tracking-wide text-ink-900 dark:text-paper-100">{c.name}</div>
                      {c.role && <div className="mt-0.5 font-serif text-xs text-ink-500">{c.role}</div>}
                      {c.description && <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-ink-600 dark:text-ink-300">{c.description}</p>}
                    </li>
                  ))}
                </ul>
              </Group>

              <Group title={t.studio.settings} count={settings.length}>
                <ul aria-label={t.studio.settings} className="grid grid-cols-2 gap-3">
                  {settings.map((s) => (
                    <li key={s.id} className="rounded-2xl bg-paper-100/80 p-4 dark:bg-paper-900/70">
                      <div className="font-serif text-sm font-semibold tracking-wide text-ink-900 dark:text-paper-100">{s.name}</div>
                      {s.description && <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-ink-600 dark:text-ink-300">{s.description}</p>}
                    </li>
                  ))}
                </ul>
              </Group>

              <Group title={t.studio.arcs} count={arcs.length}>
                <ol aria-label={t.studio.arcs} className="flex gap-4 overflow-x-auto pb-2">
                  {arcs.map((a, i) => (
                    <li key={a.id} className="w-60 shrink-0">
                      <div className="mb-3 flex items-center gap-2" aria-hidden="true">
                        <span className="h-2 w-2 shrink-0 rounded-full bg-tea-500" />
                        <span className={cn('h-px flex-1', i < arcs.length - 1 ? 'bg-tea-200 dark:bg-tea-800' : 'bg-transparent')} />
                      </div>
                      <div className="font-serif text-xs text-ink-400">{fmt(t.studio.planning.arcRange, { from: a.startChapterNo, to: a.endChapterNo })}</div>
                      <div className="mt-0.5 font-serif text-sm font-semibold tracking-wide text-ink-900 dark:text-paper-100">{a.title}</div>
                      {a.summary && <p className="mt-1.5 line-clamp-4 text-xs leading-relaxed text-ink-600 dark:text-ink-300">{a.summary}</p>}
                    </li>
                  ))}
                </ol>
              </Group>

              <Group title={t.studio.beats} count={beats.length}>
                <ul aria-label={t.studio.beats} className="space-y-2">
                  {beats.map((b) => (
                    <li key={b.id} className="flex gap-3 text-sm">
                      <span className="w-14 shrink-0 pt-px font-serif text-xs text-ink-400">{b.chapterNo ? fmt(t.studio.chapterNo, { n: b.chapterNo }) : ''}</span>
                      <span className="min-w-0 flex-1 leading-relaxed"><span className="font-serif font-medium text-ink-900 dark:text-paper-100">{b.title}</span>{b.summary && <span className="text-ink-600 dark:text-ink-300">　{b.summary}</span>}</span>
                    </li>
                  ))}
                </ul>
              </Group>
            </section>
          )}

          {tableDone && (
            <section className="mb-8">
              <SectionTitle action={
                <span className="flex items-center gap-3 font-serif text-xs text-ink-500">
                  {failed.length > 0 && <span className="inline-flex items-center gap-1 text-cinnabar-700 dark:text-cinnabar-100"><ShieldAlert size={13} strokeWidth={1.75} aria-hidden="true" />{fmt(t.studio.planning.styleFailed, { n: failed.length })}</span>}
                  <span>{fmt(t.studio.planning.tableSummary, { chapters: chapters.length, chars: totalTarget.toLocaleString() })}</span>
                </span>
              }>{t.studio.planning.chapterTable}</SectionTitle>
              <Card className="p-2">
                <ol aria-label={t.studio.planning.chapterTable}>
                  {chapters.map((c) => (
                    <li key={c.id} className="flex gap-4 border-b border-paper-300/50 px-4 py-3 last:border-0 dark:border-paper-800">
                      <span className="w-10 shrink-0 pt-px font-serif text-sm text-ink-400">{c.chapterNo}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-3">
                          <span className="truncate font-serif text-sm font-medium tracking-wide text-ink-900 dark:text-paper-100">{c.title}</span>
                          {reviews.get(c.id)?.verdict === 'revise' && (
                            <span className="flex shrink-0 items-center gap-1.5" title={fmt(t.studio.planning.styleFailedTitle, { score: reviews.get(c.id)!.styleScore })}>
                              <Badge tone="red">{t.studio.planning.styleFailedBadge}</Badge>
                              <Button size="sm" variant="ghost" className="px-1.5" disabled={running} onClick={() => void recheck(c.chapterNo)}>{t.studio.planning.recheck}</Button>
                            </span>
                          )}
                          <span className="ml-auto shrink-0 font-serif text-xs text-ink-500">{fmt(t.studio.chaptersTab.targetCount, { n: c.targetChars.toLocaleString() })}</span>
                        </div>
                        {c.goal && <p className="mt-0.5 text-xs leading-relaxed text-ink-500">{c.goal}</p>}
                      </div>
                    </li>
                  ))}
                </ol>
              </Card>
            </section>
          )}
        </div>
      </div>

      {/* Scroll the sidebar as a whole; shrinking cards lets actions overflow into the next card. */}
      <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto border-l border-paper-300/60 bg-paper-100/60 p-5 [&>*]:shrink-0 dark:border-paper-800 dark:bg-paper-900/60">
        <Card className="flex min-h-0 flex-col">
          <h2 className="font-sans text-base font-semibold tracking-tight text-ink-800 dark:text-paper-100">{t.studio.planning.notepad}</h2>
          <p className="mt-0.5 text-xs text-ink-400">{t.studio.planning.notepadHint}</p>
          <p className="mt-3 text-xs leading-relaxed text-tea-700 dark:text-tea-200">{proposals.length ? t.studio.workflow.reviewHere : !outlineDone ? t.studio.workflow.nextOutline : !tableDone ? t.studio.workflow.nextTable : t.studio.workflow.nextWrite}</p>
          {latestJob?.status === 'failed' && <div className="mt-3 space-y-2 rounded-xl bg-cinnabar-50 p-3 dark:bg-cinnabar-950"><p role="alert" className="text-xs text-cinnabar-700 dark:text-cinnabar-100">{latestJob.error}</p><JobControls job={latestJob} /></div>}
          <ol className="mt-5 space-y-5">
            <Step done={outlineDone && !waitingOutline} waiting={waitingOutline} running={activeJob?.status === 'running' && activeKind === 'outline'} title={t.studio.planning.stepOutline} hint={t.studio.planning.stepOutlineHint}
              action={waitingOutline ? <Button size="sm" onClick={showReview}>{t.studio.workflow.reviewAction}</Button> : outlineDone
                ? docTypeGuide(novel.requirements.docType).fiction ? <StoryOptionsButton novel={novel} scope={{ kind: 'work', id: novel.id }} label={t.studio.planning.redoOutline} onChanged={onChanged} /> : <Button size="sm" variant="ghost" disabled={running} onClick={doOutline}><RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />{t.studio.planning.redoOutline}</Button>
                : <><Button variant="ai" className="w-full" disabled={running} onClick={doOutline}><Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />{t.studio.planning.doOutline}</Button><CostEstimateLine preview={planCost ?? null} prefix={t.studio.planning.planCostPrefix} /></>} />
            <Step done={tableDone && !waitingTable} waiting={waitingTable} running={activeJob?.status === 'running' && activeKind === 'chapter_table'} title={t.studio.planning.stepTable} hint={t.studio.planning.stepTableHint}
              action={waitingTable ? <Button size="sm" onClick={showReview}>{t.studio.workflow.reviewAction}</Button> : !outlineDone ? null : tableDone
                ? <Button size="sm" variant="ghost" disabled={tableBlocked} onClick={doTable}><RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />{missingPlan ? t.studio.planning.completeTable : t.studio.planning.redoTable}</Button>
                : <Button variant="ai" className="w-full" disabled={tableBlocked} onClick={doTable}><Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />{t.studio.planning.doTable}</Button>} />
            <Step done={false} running={activeJob?.status === 'running' && activeKind === 'write_chapter'} title={t.studio.planning.stepWrite} hint={t.studio.planning.stepWriteHint}
              action={tableDone
                ? <><Button variant="ai" className="w-full" disabled={running} onClick={doStart}><Play size={16} strokeWidth={1.75} aria-hidden="true" />{t.studio.planning.doStart}</Button><CostEstimateLine preview={genCost ?? null} prefix={t.studio.planning.genCostPrefix} /></>
                : null} />
          </ol>
          {activeJob && (
            <div className="mt-5 flex min-h-0 flex-col">
              <div className="mb-2 flex items-center gap-2 text-xs text-tea-700 dark:text-tea-200" role="status" aria-live="polite">
                {isJobWorking(activeJob.status) || isJobTransitioning(activeJob.status) ? <ActivityStatus label={jobActivityMessage(activeJob)} elapsed startedAt={stepsByJob[activeJob.id]?.find(s => s.id === activeJob.progress.currentStepId)?.startedAt ?? activeJob.startedAt} /> : <span>{jobActivityMessage(activeJob)}</span>}
                <JobControls job={activeJob} compact />
              </div>
              {isJobWorking(activeJob.status) && <p className="text-xs leading-relaxed text-ink-500">{t.studio.workflow.generatedHere}</p>}
            </div>
          )}
        </Card>

        <Card>
          <h2 className="font-sans text-base font-semibold tracking-tight text-ink-800 dark:text-paper-100">{t.studio.planning.models}</h2>
          <p className="mt-0.5 mb-4 text-xs text-ink-400">{t.studio.planning.modelsHint}</p>
          <ModelPurposePicker value={providerIds ?? {}} onChange={saveProviders} />
        </Card>

        <UsageCards novelId={novel.id} jobId={activeJob?.id ?? null} tick={tick} />
      </aside>
    </div>
  );
}

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 font-sans text-sm tracking-tight text-ink-600 dark:text-ink-300">{title}<span className="ml-1.5 text-xs text-ink-400">{count}</span></h3>
      {children}
    </div>
  );
}

function Step({ done, running, waiting, title, hint, action }: { done: boolean; running: boolean; waiting?: boolean; title: string; hint: string; action: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden="true">
        {running ? <Spinner className="h-4 w-4" /> : done ? <CheckCircle2 size={18} strokeWidth={1.75} className="text-tea-600" /> : <Circle size={18} strokeWidth={1.5} className="text-paper-400" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className={cn('font-serif text-sm tracking-wide', done ? 'text-ink-500' : 'text-ink-900 dark:text-paper-100')}>{title}{waiting && <Badge tone="amber" className="ml-2">{t.studio.workflow.pendingReview}</Badge>}</div>
        <div className="text-xs text-ink-400">{hint}</div>
        {action && <div className="mt-2 space-y-1.5">{action}</div>}
      </div>
    </li>
  );
}
