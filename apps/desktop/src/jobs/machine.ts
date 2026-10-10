import type { JobStatus } from '@/db/repos/jobsRepo';

export type JobEventName = 'start' | 'pause' | 'resume' | 'cancel' | 'stepDone' | 'allDone' | 'stepFailed' | 'retry' | 'aborted' | 'boot';

/** Pure job state machine. Throws on illegal transitions so bugs surface in tests. */
export function transition(status: JobStatus, event: JobEventName): JobStatus {
  const table: Partial<Record<JobStatus, Partial<Record<JobEventName, JobStatus>>>> = {
    queued: { start: 'running', cancel: 'cancelled', boot: 'queued' },
    running: { pause: 'pausing', cancel: 'cancelling', stepDone: 'running', allDone: 'completed', stepFailed: 'failed', boot: 'paused' },
    pausing: { aborted: 'paused', stepDone: 'paused', cancel: 'cancelling', boot: 'paused' },
    paused: { resume: 'running', cancel: 'cancelled', boot: 'paused' },
    cancelling: { aborted: 'cancelled', stepDone: 'cancelled', boot: 'cancelled' },
    awaiting_review: { resume: 'running', retry: 'running', cancel: 'cancelled', boot: 'awaiting_review' },
    failed: { retry: 'running', cancel: 'cancelled', boot: 'failed' },
    cancelled: { boot: 'cancelled' },
    completed: { boot: 'completed' },
  };
  const next = table[status]?.[event];
  if (!next) throw new Error(`非法的任务状态转移：${status} --${event}-->`);
  return next;
}

export function canTransition(status: JobStatus, event: JobEventName): boolean {
  try {
    transition(status, event);
    return true;
  } catch {
    return false;
  }
}

export const TERMINAL: ReadonlySet<JobStatus> = new Set(['completed', 'failed', 'cancelled']);
export const ACTIVE: ReadonlySet<JobStatus> = new Set(['running', 'pausing', 'cancelling']);
