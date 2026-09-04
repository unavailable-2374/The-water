import { getSetting } from '@/db/repos/settingsRepo';
import {
  getJob, listJobs, listSteps, markInterrupted, nextPendingStep, setJobStatus, stepCounts, stepDone, stepFailed, stepPartial, stepReset, stepSkipped, stepStarted, updateProgress, getStep,
  type Job, type JobStatus,
} from '@/db/repos/jobsRepo';
import { getNovel, updateNovel } from '@/db/repos/novelsRepo';
import { listChapters, novelCharCount, setChapterStatus } from '@/db/repos/chaptersRepo';
import { providerById, providerForPurpose } from '@/llm/registry';
import { LLMError, type LLMProvider } from '@/llm/types';
import { transition } from './machine';
import { emitJobEvent } from './events';
import { STEP_HANDLERS } from './steps';
import type { StepContext } from './context';

const controllers = new Map<string, AbortController>();
let loopRunning = false;
let wake: (() => void) | null = null;

async function emitJob(id: string): Promise<void> {
  const job = await getJob(id);
  if (job) emitJobEvent({ type: 'job:updated', job });
}
async function emitStep(id: string): Promise<void> {
  const step = await getStep(id);
  if (step) emitJobEvent({ type: 'step:updated', step });
}

/** Called once at boot: recover interrupted jobs and (optionally) resume them. */
export async function startJobRunner(): Promise<void> {
  const interrupted = await markInterrupted();
  const auto = await getSetting<boolean>('autoResumeJobs', true);
  for (const j of interrupted) {
    if (auto && j.interrupted) await setJobStatus(j.id, 'running', { interrupted: false });
    await emitJob(j.id);
  }
  // queued jobs also start
  for (const j of await listJobs({ statuses: ['queued'] })) await setJobStatus(j.id, 'running');
  kick();
}

export function kick(): void {
  if (wake) { wake(); wake = null; }
  if (!loopRunning) void loop();
}

async function loop(): Promise<void> {
  loopRunning = true;
  try {
    for (;;) {
      // Jobs created at runtime start as 'queued'; promote them here (boot does the same in startJobRunner).
      for (const q of await listJobs({ statuses: ['queued'] })) {
        await setJobStatus(q.id, transition('queued', 'start'));
        await emitJob(q.id);
      }
      const running = await listJobs({ statuses: ['running', 'pausing', 'cancelling'] });
      const job = running.find((j) => j.status === 'running') ?? running[0];
      if (!job) break;
      await processOne(job);
    }
  } catch (e) {
    console.error('job loop crashed', e);
  } finally {
    loopRunning = false;
  }
}

async function resolveProvider(job: Job): Promise<LLMProvider> {
  if (job.providerId) {
    try { return await providerById(job.providerId); } catch { /* fall through to default */ }
  }
  return (await providerForPurpose('writing')).provider;
}

async function processOne(job: Job): Promise<void> {
  if (job.status === 'pausing') { await finalize(job.id, 'paused'); return; }
  if (job.status === 'cancelling') { await finalize(job.id, 'cancelled'); return; }
  const step = await nextPendingStep(job.id);
  if (!step) {
    const failed = (await listSteps(job.id)).some((s) => s.status === 'failed');
    await finalize(job.id, failed ? 'failed' : 'completed');
    return;
  }
  const handler = STEP_HANDLERS[step.kind];
  if (!handler) { await stepSkipped(step.id); await emitStep(step.id); return; }

  const ac = new AbortController();
  controllers.set(job.id, ac);
  await stepStarted(step.id);
  await updateProgress(job.id, { currentStepId: step.id, message: '' });
  await emitStep(step.id);
  await emitJob(job.id);

  let lastFlush = 0;
  let lastEmit = 0;
  let pendingText = '';
  const ctx: StepContext = {
    job, step, signal: ac.signal,
    provider: await resolveProvider(job),
    onDelta: (acc) => {
      pendingText = acc;
      const t = Date.now();
      if (t - lastEmit > 150) { lastEmit = t; emitJobEvent({ type: 'step:delta', jobId: job.id, stepId: step.id, text: acc }); }
      if (t - lastFlush > 3000) { lastFlush = t; void stepPartial(step.id, acc); }
    },
    setMessage: (msg) => { void updateProgress(job.id, { message: msg }).then(() => emitJob(job.id)); },
  };

  try {
    const out = await handler(ctx);
    await stepDone(step.id, out.outputRef);
    const counts = await stepCounts(job.id);
    await updateProgress(job.id, { done: counts.done, total: counts.total, currentStepId: null, charsSoFar: await novelCharCount(job.novelId) });
    emitJobEvent({ type: 'step:delta', jobId: job.id, stepId: step.id, text: '' });
  } catch (e) {
    const aborted = (e instanceof LLMError && e.kind === 'aborted') || (e instanceof Error && e.name === 'AbortError') || ac.signal.aborted;
    if (aborted) {
      await stepReset(step.id);
      if (pendingText) await stepPartial(step.id, pendingText);
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('step failed', step.kind, msg);
      await stepFailed(step.id, msg);
      const cur = await getJob(job.id);
      if (cur && cur.status === 'running') await setJobStatus(job.id, transition('running', 'stepFailed'), { error: msg });
      if (step.chapterId) await setChapterStatus(step.chapterId, 'planned').catch(() => undefined);
    }
  } finally {
    controllers.delete(job.id);
    await emitStep(step.id);
    await emitJob(job.id);
  }
}

async function finalize(jobId: string, status: JobStatus): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;
  if (job.status !== status) await setJobStatus(jobId, status);
  if (status === 'completed') {
    const novel = await getNovel(job.novelId);
    if (novel) {
      const chapters = await listChapters(novel.id);
      const allWritten = chapters.length > 0 && chapters.every((c) => c.currentVersionId);
      await updateNovel(novel.id, { status: allWritten ? 'complete' : 'writing' });
    }
  }
  await emitJob(jobId);
}

export async function pauseJob(id: string): Promise<void> {
  const job = await getJob(id);
  if (!job || job.status !== 'running') return;
  await setJobStatus(id, transition(job.status, 'pause'));
  controllers.get(id)?.abort();
  await emitJob(id);
  kick();
}

export async function resumeJob(id: string): Promise<void> {
  const job = await getJob(id);
  if (!job) return;
  if (job.status === 'paused') await setJobStatus(id, transition('paused', 'resume'), { interrupted: false });
  else if (job.status === 'failed') {
    for (const s of await listSteps(id)) if (s.status === 'failed') await stepReset(s.id);
    await setJobStatus(id, transition('failed', 'retry'), { error: null });
  } else return;
  await emitJob(id);
  kick();
}

export async function skipFailedStep(id: string): Promise<void> {
  const job = await getJob(id);
  if (!job || job.status !== 'failed') return;
  for (const s of await listSteps(id)) if (s.status === 'failed') await stepSkipped(s.id);
  await setJobStatus(id, 'running', { error: null });
  await emitJob(id);
  kick();
}

export async function cancelJob(id: string): Promise<void> {
  const job = await getJob(id);
  if (!job) return;
  if (job.status === 'running') { await setJobStatus(id, 'cancelling'); controllers.get(id)?.abort(); }
  else if (['queued', 'paused', 'failed', 'pausing'].includes(job.status)) { await setJobStatus(id, 'cancelled'); controllers.get(id)?.abort(); }
  else return;
  await emitJob(id);
  kick();
}

export function isJobActive(id: string): boolean {
  return controllers.has(id);
}
