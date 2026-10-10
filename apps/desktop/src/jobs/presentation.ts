import type { Job, JobStep } from '@/db/repos/jobsRepo';
import { t } from '@/i18n';

/** Pending review and paused jobs must never look like active model generation. */
export const isJobWorking = (status: Job['status']) => status === 'running';
export const isJobTransitioning = (status: Job['status']) => status === 'pausing' || status === 'cancelling';
export const isStepAwaitingReview = (job: Pick<Job, 'status' | 'progress'>, step: Pick<JobStep, 'id' | 'status'>) =>
  job.status === 'awaiting_review' && job.progress.currentStepId === step.id && step.status === 'failed';
/** A blocked prerequisite is not a generated candidate. Includes legacy persisted jobs. */
export function jobAwaitingAction(job: Pick<Job,'error'>, step?: Pick<JobStep,'kind'|'input'|'error'>): 'memory'|'proposal'|'chapter'|'blocker' {
  const message=job.error ?? step?.error ?? '';
  const action=step?.input.awaitingAction as {kind?:string}|undefined;
  if (action?.kind === 'memory' || /^第 \d+ 章记忆尚未重建/.test(message)) return 'memory';
  if (action?.kind==='proposal' || action?.kind==='chapter' || action?.kind==='blocker') return action.kind;
  if (typeof step?.input.planProposalId === 'string' || /^(本章场景建议已生成|场景计划已生成|本章仍有待核对场景|本章仍有待核对的场景卡|请先确认本章场景计划)/.test(message)) return 'proposal';
  if (step && ['style_check','summarize','commit_chapter','rewrite_chapter','adjust_length'].includes(step.kind)) return 'chapter';
  return 'blocker';
}
export function jobAwaitingLabel(job: Pick<Job,'error'>, step?: Pick<JobStep,'kind'|'input'|'error'>): string {
  return ({memory:t.studio.workflow.rebuildAndContinue,proposal:t.studio.workflow.reviewAction,chapter:t.studio.workflow.checkChapter,blocker:t.studio.workflow.resolveBlocker})[jobAwaitingAction(job,step)];
}
/** Resolve approval to its authoring page, rather than asking users to inspect task logs. */
export function jobReviewPath(job: Pick<Job, 'novelId' | 'type' | 'params'> & Partial<Pick<Job,'error'>>, step?: Pick<JobStep, 'kind' | 'chapterId'> & Partial<Pick<JobStep,'input'|'error'>>): string {
  const base = `/studio/${job.novelId}`;
  const action=step?.input?.awaitingAction as {kind?:string;chapterId?:string;chapterNo?:number}|undefined;
  const legacyNo=/^第 (\d+) 章记忆尚未重建/.exec(job.error ?? step?.error ?? '')?.[1];
  if (action?.kind === 'memory' || legacyNo) return `${base}/chapters?${action?.chapterId ? `chapter=${encodeURIComponent(action.chapterId)}` : `chapterNo=${action?.chapterNo ?? legacyNo}`}`;
  if (step?.kind === 'extract_style' || job.type === 'extract_style') return `${base}/storyline`;
  if (step?.kind === 'outline' || step?.kind === 'chapter_table' || (!step && job.params.stage === 'plan')) return `${base}/plan`;
  return `${base}/chapters${step?.chapterId ? `?chapter=${encodeURIComponent(step.chapterId)}` : ''}`;
}
export function jobActivityMessage(job: Pick<Job, 'status' | 'progress'>): string {
  return isJobWorking(job.status) ? job.progress.message || t.jobs.status.running : t.jobs.status[job.status];
}
export function jobDisplayOrder(status: Job['status']): number {
  return ({ running: 0, pausing: 1, cancelling: 1, queued: 2, awaiting_review: 3, failed: 4, paused: 5, completed: 6, cancelled: 6 })[status];
}
