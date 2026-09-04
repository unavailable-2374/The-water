import { useEffect, useMemo, useState } from 'react';
import { Feather, Pause, Play, RotateCw, Square, SkipForward, Trash2 } from 'lucide-react';
import { t } from '@/i18n/zh';
import { Button, EmptyState, cn } from '@/components/ui';
import type { Novel } from '@/db/repos/novelsRepo';
import { deleteJob, type Job, type JobStep } from '@/db/repos/jobsRepo';
import { cancelJob, canActOnStep, pauseJob, resumeJob, retryStep, skipFailedStep, skipStep } from '@/jobs/runner';
import { STEP_LABELS } from '@/jobs/steps';
import { isPlanningJob } from '@/novel/service';
import { useJobs } from '@/stores/jobsStore';
import { UsageCards } from './UsagePanel';

/** Warm, reader-facing wording for job states (the raw i18n labels stay for settings/logs). */
export const JOB_STATUS_LABEL: Record<Job['status'], string> = {
  queued: '排队中', running: 'AI 正在写作', pausing: '正在暂停', paused: '已暂停', cancelling: '正在停下', cancelled: '已取消', failed: '遇到问题', completed: '已完成',
};
export const JOB_STATUS_DOT: Record<Job['status'], string> = {
  queued: 'bg-ink-300', running: 'bg-tea-500 animate-pulse', pausing: 'bg-amber-500', paused: 'bg-amber-500', cancelling: 'bg-ink-300', cancelled: 'bg-ink-300', failed: 'bg-cinnabar-500', completed: 'bg-tea-600',
};
const TYPE_LABEL: Record<Job['type'], string> = { generate_novel: '写整本书', regenerate_chapter: '重写一章', rewrite: '改写章节', extract_style: '拆书提取文风', style_check: '审校一章' };

/** 规划任务与写作任务同属 generate_novel，靠 params.stage 区分（见 novel/service.ts）。 */
function jobLabel(job: Job): string {
  return isPlanningJob(job) ? '规划大纲与章节表' : TYPE_LABEL[job.type];
}

function StatusDot({ status }: { status: Job['status'] }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-600 dark:text-ink-300">
      <span className={cn('h-1.5 w-1.5 rounded-full', JOB_STATUS_DOT[status])} />{JOB_STATUS_LABEL[status]}
    </span>
  );
}

export function JobsTab({ novel }: { novel: Novel }) {
  const allJobs = useJobs((s) => s.jobs);
  const jobs = useMemo(() => Object.values(allJobs).filter((j) => j.novelId === novel.id).sort((a, b) => b.createdAt - a.createdAt), [allJobs, novel.id]);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => { if (!openId && jobs[0]) setOpenId(jobs[0].id); }, [jobs.length]);
  if (jobs.length === 0) return <EmptyState icon={<Feather size={40} strokeWidth={1.25} />} title="还没有进展" description="让 AI 开始写作后，它每一步做了什么都会记在这里。" />;
  return (
    <div className="grid h-full grid-rows-[minmax(0,1fr)] grid-cols-[300px_1fr] bg-paper-50 dark:bg-paper-950">
      <ul className="overflow-y-auto border-r border-paper-300/60 bg-paper-100/60 px-3 py-4 dark:border-paper-800 dark:bg-paper-900/60">
        <li className="mb-2 px-3 font-serif text-[11px] tracking-[0.2em] text-ink-500">进展</li>
        {jobs.map((j) => (
          <li key={j.id}>
            <button onClick={() => setOpenId(j.id)} className={cn('mb-1 w-full rounded-xl px-3 py-2.5 text-left transition', openId === j.id ? 'bg-paper-0 shadow-soft dark:bg-paper-800' : 'hover:bg-paper-200/60 dark:hover:bg-paper-800/60')}>
              <div className="flex items-center gap-2"><span className="font-serif text-sm text-ink-900 dark:text-paper-100">{jobLabel(j)}</span><span className="ml-auto"><StatusDot status={j.status} /></span></div>
              <div className="mt-1 text-[11px] text-ink-400"><span className="font-serif">{j.progress.done}/{j.progress.total}</span> 步 · {new Date(j.createdAt).toLocaleString()}{j.interrupted ? ' · 曾中断' : ''}</div>
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
          <div className="flex items-center gap-3"><StatusDot status={job.status} /><span className="truncate text-sm text-ink-600 dark:text-ink-300">{job.progress.message}</span></div>
          <div className="mt-3 h-0.5 w-full rounded-full bg-paper-300 dark:bg-paper-800"><div className="h-0.5 rounded-full bg-tea-500 transition-all" style={{ width: `${pct}%` }} /></div>
          <div className="mt-2 text-xs text-ink-400"><span className="font-serif">{job.progress.done}/{job.progress.total}</span> 步 · 已写 <span className="font-serif">{job.progress.charsSoFar.toLocaleString()}</span> 字{job.error ? <span className="text-cinnabar-600 dark:text-cinnabar-100"> · {job.error}</span> : null}</div>
        </div>
        <JobControls job={job} />
      </div>
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] grid-cols-[minmax(260px,2fr)_3fr] gap-4 px-8 pb-6">
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          <ul className="rounded-2xl bg-paper-100/70 p-2 text-xs dark:bg-paper-900/70">
            {(steps ?? []).map((s) => <StepRow key={s.id} job={job} step={s} active={live?.stepId === s.id} />)}
          </ul>
          <UsageCards novelId={job.novelId} jobId={job.id} tick={job.progress.done} />
        </div>
        <div className="paper-texture overflow-y-auto whitespace-pre-wrap rounded-2xl bg-paper-0 px-8 py-6 font-serif text-sm leading-[1.9] text-ink-800 shadow-soft dark:bg-paper-900 dark:text-paper-100">
          {live?.text ? <>{live.text}<span className="ml-0.5 inline-block h-[1em] w-0.5 animate-pulse bg-tea-500 align-text-bottom" /></> : <span className="text-ink-400">{job.status === 'running' ? 'AI 正在酝酿…' : ''}</span>}
        </div>
      </div>
    </div>
  );
}

const STEP_STATUS: Record<JobStep['status'], { label: string; dot: string }> = {
  pending: { label: '等待', dot: 'bg-ink-300' }, running: { label: '正在写', dot: 'bg-tea-500 animate-pulse' }, done: { label: '完成', dot: 'bg-tea-600' }, failed: { label: '出错', dot: 'bg-cinnabar-500' }, skipped: { label: '跳过', dot: 'bg-amber-500' },
};

/** 单步重试 / 跳过（§2.1 第 6 条）：失败或被跳过的步骤都能单独处理，不必整任务重来。 */
function StepRow({ job, step, active }: { job: Job; step: JobStep; active: boolean }) {
  const input = step.input as { chapterNo?: number };
  const st = STEP_STATUS[step.status];
  const actionable = canActOnStep(job, step);
  return (
    <li className={cn('flex items-center gap-2 rounded-xl px-3 py-1.5', active && 'bg-paper-0 shadow-soft dark:bg-paper-800')}>
      <span className="w-6 font-serif text-ink-400">{step.seq + 1}</span>
      <span className="flex-1 truncate text-ink-800 dark:text-paper-100">{STEP_LABELS[step.kind]}{input.chapterNo ? ` · 第${input.chapterNo}章` : ''}</span>
      {step.attempts > 1 && <span className="font-serif text-ink-400" title={`已尝试 ${step.attempts} 次`}>×{step.attempts}</span>}
      <span className="inline-flex shrink-0 items-center gap-1.5 text-ink-500"><span className={cn('h-1.5 w-1.5 rounded-full', st.dot)} />{st.label}</span>
      {step.error && <span className="max-w-[32%] truncate text-cinnabar-600 dark:text-cinnabar-100" title={step.error}>{step.error}</span>}
      {actionable && (
        <span className="flex shrink-0 items-center gap-0.5">
          <Button size="sm" variant="ghost" title="只重试这一步" onClick={() => retryStep(step.id)}><RotateCw size={12} strokeWidth={1.75} />重试</Button>
          {step.status === 'failed' && <Button size="sm" variant="ghost" title="跳过这一步，继续往下走" onClick={() => skipStep(step.id)}><SkipForward size={12} strokeWidth={1.75} />跳过</Button>}
        </span>
      )}
    </li>
  );
}

export function JobControls({ job, compact }: { job: Job; compact?: boolean }) {
  const size = 'sm' as const;
  return (
    <div className="flex items-center gap-1">
      {job.status === 'running' && <Button size={size} variant="ghost" onClick={() => pauseJob(job.id)} title={t.studio.pause}><Pause size={14} strokeWidth={1.75} />{!compact && t.studio.pause}</Button>}
      {(job.status === 'paused' || job.status === 'failed') && <Button size={size} variant="ai" onClick={() => resumeJob(job.id)} title={job.status === 'failed' ? t.common.retry : t.studio.resume}><Play size={14} strokeWidth={1.75} />{!compact && (job.status === 'failed' ? t.common.retry : t.studio.resume)}</Button>}
      {job.status === 'failed' && <Button size={size} variant="ghost" onClick={() => skipFailedStep(job.id)} title="跳过所有失败的步骤"><SkipForward size={14} strokeWidth={1.75} />{!compact && '全部跳过'}</Button>}
      {!['completed', 'cancelled'].includes(job.status) && <Button size={size} variant="ghost" onClick={() => cancelJob(job.id)} title="停下"><Square size={14} strokeWidth={1.75} />{!compact && '停下'}</Button>}
      {['completed', 'cancelled', 'failed'].includes(job.status) && !compact && <Button size={size} variant="ghost" title="删除记录" onClick={async () => { await deleteJob(job.id); await useJobs.getState().loadAll(); }}><Trash2 size={14} strokeWidth={1.75} /></Button>}
    </div>
  );
}
