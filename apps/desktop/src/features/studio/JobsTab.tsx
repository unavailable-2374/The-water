import { ActivityIndicator, ActivityStatus, StreamingCursor, TaskProgress } from '@/components/Activity';
import { isJobWorking, isStepAwaitingReview, jobActivityMessage, jobReviewPath, jobAwaitingAction, jobAwaitingLabel } from '@/jobs/presentation';
import { prepareJobMemoryRepair } from '@/db/repos/jobMemoryRepair';
import { toast } from '@/components/Toast';
import { useNavigate } from 'react-router';
import { useEffect, useMemo, useState } from 'react';
import { Feather, Pause, Play, RotateCw, Square, SkipForward, Trash2 } from 'lucide-react';
import { fmt, t } from '@/i18n';
import { Button, EmptyState, IconButton, cn } from '@/components/ui';
import type { Novel } from '@/db/repos/novelsRepo';
import { isRequiredStep, deleteJob, type Job, type JobStep } from '@/db/repos/jobsRepo';
import { cancelJob, canActOnStep, pauseJob, resumeJob, retryStep, skipFailedStep, skipStep, kick } from '@/jobs/runner';
import { STEP_LABELS } from '@/jobs/steps';
import { isPlanningJob } from '@/novel/service';
import { useJobs } from '@/stores/jobsStore';
import { UsageCards } from './UsagePanel';

/**
 * 任务状态的唯一文案出处是 `t.jobs.status`（见 i18n/zh/app.ts）。
 * 这里只留一个取值函数——写成模块顶层的常量表会把文案拷贝下来，切语言就不更新了。
 */
export function jobStatusLabel(status: Job['status']): string {
  return t.jobs.status[status];
}

/** 纯 CSS 类名，不是文案，留在原地。 */
export const JOB_STATUS_DOT: Record<Job['status'], string> = {
  awaiting_review: 'bg-amber-500', queued: 'bg-ink-300', running: 'bg-tea-500 animate-pulse', pausing: 'bg-amber-500', paused: 'bg-amber-500', cancelling: 'bg-ink-300', cancelled: 'bg-ink-300', failed: 'bg-cinnabar-500', completed: 'bg-tea-600',
};

/** 规划任务与写作任务同属 generate_novel，靠 params.stage 区分（见 novel/service.ts）。 */
function jobLabel(job: Job): string {
  return isPlanningJob(job) ? t.jobs.type.planning : t.jobs.type[job.type];
}

function StatusDot({ status }: { status: Job['status'] }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-600 dark:text-ink-300">
      {isJobWorking(status) ? <ActivityIndicator /> : <span className={cn('h-1.5 w-1.5 rounded-full', JOB_STATUS_DOT[status])} aria-hidden="true" />}{jobStatusLabel(status)}
    </span>
  );
}

export function JobsTab({ novel }: { novel: Novel }) {
  const allJobs = useJobs((s) => s.jobs);
  const jobs = useMemo(() => Object.values(allJobs).filter((j) => j.novelId === novel.id).sort((a, b) => b.createdAt - a.createdAt), [allJobs, novel.id]);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => { if (!openId && jobs[0]) setOpenId(jobs[0].id); }, [jobs.length]);
  if (jobs.length === 0) return <EmptyState icon={<Feather size={40} strokeWidth={1.25} aria-hidden="true" />} title={t.studio.jobsEmptyTitle} description={t.studio.jobsEmptyDesc} />;
  return (
    <div className="grid h-full grid-rows-[minmax(0,1fr)] grid-cols-[300px_1fr] bg-paper-50 dark:bg-paper-950">
      <ul aria-label={t.studio.jobsTab.list} className="overflow-y-auto border-r border-paper-300/60 bg-paper-100/60 px-3 py-4 dark:border-paper-800 dark:bg-paper-900/60">
        <li className="mb-2 px-3 font-serif text-[11px] tracking-[0.2em] text-ink-500">{t.studio.jobsTab.listTitle}</li>
        {jobs.map((j) => (
          <li key={j.id}>
            <button aria-current={openId === j.id ? 'true' : undefined} onClick={() => setOpenId(j.id)} className={cn('mb-1 w-full rounded-xl px-3 py-2.5 text-left transition', openId === j.id ? 'bg-paper-0 shadow-soft dark:bg-paper-800' : 'hover:bg-paper-200/60 dark:hover:bg-paper-800/60')}>
              <div className="flex items-center gap-2"><span className="font-serif text-sm text-ink-900 dark:text-paper-100">{jobLabel(j)}</span><span className="ml-auto"><StatusDot status={j.status} /></span></div>
              <div className="mt-1 text-[11px] text-ink-400"><span className="font-serif">{fmt(t.studio.jobsTab.steps, { done: j.progress.done, total: j.progress.total })}</span> · {new Date(j.createdAt).toLocaleString()}{j.interrupted ? ` · ${t.studio.jobsTab.interrupted}` : ''}</div>
            </button>
          </li>
        ))}
      </ul>
      <div className="min-w-0 overflow-hidden">{openId && jobs.find((j) => j.id === openId) && <JobDetail job={jobs.find((j) => j.id === openId)!} />}</div>
    </div>
  );
}

function JobDetail({ job }: { job: Job }) {
  const steps = useJobs((s) => s.steps[job.id]);
  const live = useJobs((s) => s.live[job.id]);
  useEffect(() => { void useJobs.getState().loadSteps(job.id); }, [job.id, job.status, job.progress.done]);
  const pct = job.progress.total ? Math.round((job.progress.done / job.progress.total) * 100) : 0;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start gap-4 px-8 pt-6 pb-4">
        <div className="min-w-0 flex-1">
          {/* 任务状态是异步变化的，读屏要能跟上 */}
          <div className="flex items-center gap-3" aria-live="polite"><StatusDot status={job.status} /><span className="truncate text-sm text-ink-600 dark:text-ink-300">{jobActivityMessage(job)}</span></div>
          <TaskProgress percent={pct} active={isJobWorking(job.status)} label={fmt(t.studio.jobsTab.progressLabel, { pct })} className="mt-3 w-full" />
          <div className="mt-2 text-xs text-ink-400"><span className="font-serif">{fmt(t.studio.jobsTab.steps, { done: job.progress.done, total: job.progress.total })}</span> · <span className="font-serif">{fmt(t.studio.jobsTab.charsWritten, { n: job.progress.charsSoFar.toLocaleString() })}</span>{job.error ? <span className={job.status === 'awaiting_review' ? 'text-amber-700 dark:text-amber-200' : 'text-cinnabar-600 dark:text-cinnabar-100'} role={job.status === 'awaiting_review' ? 'status' : 'alert'}> · {job.error}</span> : null}</div>
        </div>
        <JobControls job={job} />
      </div>
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] grid-cols-[minmax(260px,2fr)_3fr] gap-4 px-8 pb-6">
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          <ul aria-label={t.studio.jobsTab.stepList} className="rounded-2xl bg-paper-100/70 p-2 text-xs dark:bg-paper-900/70">
            {(steps ?? []).map((s) => <StepRow key={s.id} job={job} step={s} active={isJobWorking(job.status) && job.progress.currentStepId === s.id} />)}
          </ul>
          <UsageCards novelId={job.novelId} jobId={job.id} tick={job.progress.done} />
        </div>
        <div className="paper-texture overflow-y-auto whitespace-pre-wrap rounded-2xl bg-paper-0 px-8 py-6 font-serif text-sm leading-[1.9] text-ink-800 shadow-soft dark:bg-paper-900 dark:text-paper-100">
          {live?.text ? <>{live.text}{isJobWorking(job.status) && <StreamingCursor />}</> : isJobWorking(job.status) ? <ActivityStatus key={`${job.id}:${job.progress.currentStepId}`} label={t.studio.jobsTab.thinking} elapsed startedAt={steps?.find(s => s.id === job.progress.currentStepId)?.startedAt ?? job.startedAt} className="text-ink-400" /> : <span className="text-ink-400">{jobStatusLabel(job.status)}</span>}
        </div>
      </div>
    </div>
  );
}

/** 单步状态的圆点颜色（文案在 `t.studio.jobsTab.stepStatus`）。 */
const STEP_DOT: Record<JobStep['status'], string> = {
  pending: 'bg-ink-300', running: 'bg-tea-500 animate-pulse', done: 'bg-tea-600', failed: 'bg-cinnabar-500', skipped: 'bg-amber-500',
};

/** 单步重试 / 跳过（§2.1 第 6 条）：失败或被跳过的步骤都能单独处理，不必整任务重来。 */
function StepRow({ job, step, active }: { job: Job; step: JobStep; active: boolean }) {
  const input = step.input as { chapterNo?: number };
  const awaitingReview = isStepAwaitingReview(job, step);
  const actionable = !awaitingReview && canActOnStep(job, step);
  return (
    <li className={cn('flex items-center gap-2 rounded-xl px-3 py-1.5', active && 'bg-paper-0 shadow-soft dark:bg-paper-800')}>
      <span className="w-6 font-serif text-ink-400">{step.seq + 1}</span>
      <span className="flex-1 truncate text-ink-800 dark:text-paper-100">{STEP_LABELS[step.kind]}{input.chapterNo ? ` · ${fmt(t.studio.chapterNo, { n: input.chapterNo })}` : ''}</span>
      {step.attempts > 1 && <span className="font-serif text-ink-400" title={fmt(t.studio.jobsTab.attempts, { n: step.attempts })}>×{step.attempts}</span>}
      <span className="inline-flex shrink-0 items-center gap-1.5 text-ink-500"><span className={cn('h-1.5 w-1.5 rounded-full', awaitingReview ? 'bg-amber-500' : STEP_DOT[step.status === 'running' && !isJobWorking(job.status) ? 'pending' : step.status])} aria-hidden="true" />{awaitingReview || (step.status === 'running' && !isJobWorking(job.status)) ? jobStatusLabel(job.status) : t.studio.jobsTab.stepStatus[step.status]}</span>
      {step.error && <span className={cn('max-w-[32%] truncate', awaitingReview ? 'text-amber-700 dark:text-amber-200' : 'text-cinnabar-600 dark:text-cinnabar-100')} title={step.error}>{step.error}</span>}
      {actionable && (
        <span className="flex shrink-0 items-center gap-0.5">
          <Button size="sm" variant="ghost" title={t.studio.jobsTab.retryStep} onClick={() => retryStep(step.id)}><RotateCw size={12} strokeWidth={1.75} aria-hidden="true" />{t.common.retry}</Button>
          {step.status === 'failed' && !isRequiredStep(step.kind) && <Button size="sm" variant="ghost" title={t.studio.jobsTab.skipStep} onClick={() => skipStep(step.id)}><SkipForward size={12} strokeWidth={1.75} aria-hidden="true" />{t.studio.jobsTab.skip}</Button>}
        </span>
      )}
    </li>
  );
}

export function JobControls({ job, compact }: { job: Job; compact?: boolean }) {
  const nav = useNavigate();
  const steps = useJobs(s => s.steps[job.id]);
  const step = steps?.find(s => s.id === job.progress.currentStepId);
  const [repairing,setRepairing]=useState(false);
  const waiting=jobAwaitingAction(job,step);
  const handleWaiting=async()=>{
    if (repairing) return;
    if (waiting==='memory') {
      setRepairing(true);
      try {const chapterId=await prepareJobMemoryRepair(job.id);nav(`/studio/${job.novelId}/chapters?chapter=${encodeURIComponent(chapterId)}`);kick();}
      catch(error){toast.error(error instanceof Error?error.message:String(error));}
      finally{setRepairing(false);}
    } else {
      nav(waiting==='blocker'?`/studio/${job.novelId}/jobs`:jobReviewPath(job,step));
      if(waiting==='proposal')document.getElementById('generated-review')?.scrollIntoView({block:'start',behavior:'smooth'});
    }
  };
  useEffect(() => { if (job.status === 'awaiting_review' && !steps) void useJobs.getState().loadSteps(job.id); }, [job.id, job.status, steps]);
  const size = 'sm' as const;
  const resumeLabel = job.status === 'failed' ? t.common.retry : t.studio.resume;
  return (
    <div className="flex items-center gap-1">
      {job.status === 'running' && <Button size={size} variant="ghost" onClick={() => pauseJob(job.id)} title={t.studio.pause} aria-label={t.studio.pause}><Pause size={14} strokeWidth={1.75} aria-hidden="true" />{!compact && t.studio.pause}</Button>}
      {job.status === 'awaiting_review' && <Button size={size} variant="primary" disabled={repairing || !step} onClick={()=>void handleWaiting()}>{jobAwaitingLabel(job,step)}</Button>}
      {(job.status === 'paused' || job.status === 'failed' || (job.status === 'awaiting_review' && step && !['memory','proposal'].includes(waiting))) && <Button size={size} variant="ai" onClick={() => resumeJob(job.id)} title={resumeLabel} aria-label={resumeLabel}><Play size={14} strokeWidth={1.75} aria-hidden="true" />{!compact && resumeLabel}</Button>}
      {job.status === 'failed' && <Button size={size} variant="ghost" onClick={() => skipFailedStep(job.id)} title={t.studio.jobsTab.skipAllFailed} aria-label={t.studio.jobsTab.skipAll}><SkipForward size={14} strokeWidth={1.75} aria-hidden="true" />{!compact && t.studio.jobsTab.skipAll}</Button>}
      {!['completed', 'cancelled'].includes(job.status) && <Button size={size} variant="ghost" onClick={() => cancelJob(job.id)} title={t.studio.jobsTab.stop} aria-label={t.studio.jobsTab.stop}><Square size={14} strokeWidth={1.75} aria-hidden="true" />{!compact && t.studio.jobsTab.stop}</Button>}
      {['completed', 'cancelled', 'failed'].includes(job.status) && !compact && <IconButton label={t.studio.jobsTab.deleteRecord} onClick={async () => { await deleteJob(job.id); await useJobs.getState().loadAll(); }}><Trash2 size={14} strokeWidth={1.75} aria-hidden="true" /></IconButton>}
    </div>
  );
}
