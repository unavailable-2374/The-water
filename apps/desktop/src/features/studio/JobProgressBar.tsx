import { ActivityIndicator, TaskProgress } from '@/components/Activity';
import { isJobWorking, jobActivityMessage, jobDisplayOrder, jobReviewPath, jobAwaitingAction, jobAwaitingLabel } from '@/jobs/presentation';
import { useNavigate } from 'react-router';
import { useMemo } from 'react';
import { fmt, t } from '@/i18n';
import { cn } from '@/components/ui';
import { useAsyncData } from '@/components/data/useAsyncData';
import { getNovel } from '@/db/repos/novelsRepo';
import { useJobs } from '@/stores/jobsStore';
import { JOB_STATUS_DOT, JobControls, jobStatusLabel } from './JobsTab';

/** Global bottom bar shown while any job is active. */
export function JobProgressBar() {
  const allJobs = useJobs((s) => s.jobs);
  const jobs = useMemo(
    () => Object.values(allJobs).filter((j) => ['running', 'pausing', 'paused', 'queued', 'cancelling', 'failed', 'awaiting_review'].includes(j.status)).sort((a, b) => jobDisplayOrder(a.status) - jobDisplayOrder(b.status) || b.createdAt - a.createdAt),
    [allJobs],
  );
  const nav = useNavigate();
  const job = jobs[0];
  const steps = useJobs(s => job ? s.steps[job.id] : undefined);
  const step = steps?.find(s => s.id === job?.progress.currentStepId);
  const novelId = job?.novelId ?? '';
  const { data: title } = useAsyncData(
    async () => (await getNovel(novelId))?.title ?? '',
    { key: `progressBarNovel:${novelId}`, enabled: !!novelId },
  );
  if (!job) return null;
  const pct = job.progress.total ? Math.round((job.progress.done / job.progress.total) * 100) : 0;
  return (
    <div className="flex h-11 items-center gap-3 border-t border-paper-300/60 bg-paper-100/85 px-5 text-xs backdrop-blur dark:border-paper-800 dark:bg-paper-900/85">
      <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => nav(job.status === 'awaiting_review' && jobAwaitingAction(job,step)!=='blocker' ? jobReviewPath(job, step) : `/studio/${job.novelId}/jobs`)} title={job.status === 'awaiting_review' ? jobAwaitingLabel(job,step) : t.studio.jobsTab.viewProgress}>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-ink-600 dark:text-ink-300" aria-live="polite">{isJobWorking(job.status) ? <ActivityIndicator /> : <span className={cn('h-1.5 w-1.5 rounded-full', JOB_STATUS_DOT[job.status])} aria-hidden="true" />}{jobStatusLabel(job.status)}</span>
        <span className="truncate font-serif text-sm text-ink-900 dark:text-paper-100">{title ?? ''}</span>
        <span className="truncate text-ink-400">{job.status==='awaiting_review' ? job.error || jobActivityMessage(job) : jobActivityMessage(job)}</span>
        <span className="shrink-0 font-serif text-ink-500">{fmt(t.studio.jobsTab.charsWritten, { n: job.progress.charsSoFar.toLocaleString() })}</span>
        <TaskProgress percent={pct} active={isJobWorking(job.status)} label={fmt(t.studio.jobsTab.progressLabel, { pct })} className="w-40 shrink-0" />
        {jobs.length > 1 && <span className="shrink-0 text-ink-400">{fmt(t.studio.jobsTab.moreJobs, { n: jobs.length - 1 })}</span>}
      </button>
      <JobControls job={job} compact />
    </div>
  );
}
