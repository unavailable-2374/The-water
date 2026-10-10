import { isBlockingJob, type Job } from '@/db/repos/jobsRepo';

type AdmissionJob = Pick<Job, 'id' | 'status' | 'params'>;
/** Planning can run at a saved prose checkpoint; pending planning reviews still block. */
export function canSupplementPlan(jobs: readonly AdmissionJob[]): boolean {
  return jobs.filter(j => isBlockingJob(j.status)).every(j => (j.status === 'paused' || j.status === 'awaiting_review') && j.params.stage !== 'plan');
}
export function assertJobMayResume(job: AdmissionJob, siblings: readonly AdmissionJob[]): void {
  const blockers = siblings.filter(j => j.id !== job.id && isBlockingJob(j.status));
  if (!blockers.length) return;
  if (job.params.stage === 'plan' && (job.params.fillMissing === true || job.params.replanAfterOutline === true) && canSupplementPlan(blockers)) return;
  throw new Error('请先审阅或结束补充规划任务，再继续写作');
}
