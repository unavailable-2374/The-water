import { writeAtomic, type AtomicWriter } from '@/db/db';
import { getRun as getAssistantRun } from '@/assistant/repository';
import { estimateMessagesTokens } from '@/llm/tokens';
import { assistantJobWriter } from './assistant';
import { topicMemoryScope } from './topicMemory';
import { upgradeLegacyJobs } from '@/db/repos/jobsRepo';
import { AwaitingReviewError } from './awaitingReview';
import { reconcileGenerationPlan } from './reconcilePlan';
import { assertJobMayResume } from './planningAdmission';
import { getSetting } from '@/db/repos/settingsRepo';
import {
  getJob, listJobs, listSteps, markInterrupted, nextPendingStep, setJobStatus, stepCounts, stepDone, stepFailed, stepPartial, stepReset, stepSkipped, stepStarted, updateProgress, getStep, setStepInput, isRequiredStep,
  type Job, type JobStatus, type JobStep,
} from '@/db/repos/jobsRepo';
import { getNovel, updateNovel } from '@/db/repos/novelsRepo';
import { getChapter, listChapters, novelCharCount, setChapterStatus } from '@/db/repos/chaptersRepo';
import { assertBudget, recordUsage as recordUsageEvent } from '@/db/repos/usageRepo';
import { providerById, providerForPurpose } from '@/llm/registry';
import { isTimeoutError } from '@/llm/timeout';
import { LLMError, type LLMProvider, type Usage } from '@/llm/types';
import { transition } from './machine';
import { emitJobEvent, onJobEvent } from './events';
import { recoverAcceptedPlanJobs } from '@/db/repos/planJobCompletion';
import { STEP_HANDLERS } from './steps';
import { basePurposeOf, pickProviderId, providerMapOf, STEP_PURPOSE, type StepProviderMap, type StepPurpose } from './purposes';
import { DEFAULT_STEP_AUTO_RETRIES, decideStepFailure, isRetryableStepError } from './stepRetry';
import { loadPoolLimits, planPoolStarts, taskGate } from './pool';
import type { StepContext } from './context';

const controllers = new Map<string, AbortController>();
/** 正在推进的任务：jobId → 该任务这一轮的执行 Promise 与它占用的供应商槽位。 */
const inFlight = new Map<string, { providerId: string | null; novelId: string; task: Promise<void> }>();
let loopRunning = false;
let suspendedForRestore=false;
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
  await upgradeLegacyJobs();
  await recoverAcceptedPlanJobs();
  const interrupted = await markInterrupted();
  const auto = await getSetting<boolean>('autoResumeJobs', true);
  for (const j of interrupted) {
    if (auto && j.interrupted && !j.params.assistantRunId) await setJobStatus(j.id, 'running', { interrupted: false });
    await emitJob(j.id);
  }
  // queued jobs also start
  for (const j of await listJobs({ statuses: ['queued'] })) if(await assistantMayRun(j)) await setJobStatus(j.id, 'running');
  kick();
}

export function kick(): void {
  if(suspendedForRestore) return;
  if (wake) { wake(); wake = null; }
  if (!loopRunning) void loop();
}

onJobEvent((event) => { if (event.type === 'plan:resolved' || (event.type==='job:updated' && event.job.status==='queued')) kick(); });

function nextWake(): Promise<void> {
  return new Promise<void>((resolve) => { wake = resolve; });
}

/**
 * 调度循环（§2.1 第 8 条）。不再是「一次只推进一个任务」，而是按
 * 全局上限 + 供应商级并发数挑出可以并行推进的任务；同一本小说仍然串行，
 * 免得两个任务抢同一批章节。
 */
async function loop(): Promise<void> {
  loopRunning = true;
  try {
    for (;;) {
      if(suspendedForRestore) break;
      // Jobs created at runtime start as 'queued'; promote them here (boot does the same in startJobRunner).
      for (const q of await listJobs({ statuses: ['queued'] })) {
        if(!await assistantMayRun(q)) continue;
        await setJobStatus(q.id, transition('queued', 'start'));
        await emitJob(q.id);
      }
      const candidates = (await listJobs({ statuses: ['running', 'pausing', 'cancelling'] })).filter((j) => !inFlight.has(j.id));
      // 暂停 / 取消要立刻响应，排在最前面。
      candidates.sort((a, b) => (a.status === 'running' ? 1 : 0) - (b.status === 'running' ? 1 : 0));
      const limits = await loadPoolLimits();
      const active = [...inFlight.entries()].map(([id, v]) => ({ id, providerId: v.providerId }));
      const novelOf = new Map<string, string>([
        ...[...inFlight.entries()].map(([id, v]) => [id, v.novelId] as const),
        ...candidates.map((j) => [j.id, j.novelId] as const),
      ]);
      const starts = planPoolStarts(candidates, active, limits, (id) => novelOf.get(id) ?? null);
      for (const id of starts) {
        if(suspendedForRestore) break;
        const job = candidates.find((j) => j.id === id)!;
        const entry = {
          providerId: job.providerId,
          novelId: job.novelId,
          task: (async () => {
            try { await processOne(job); } catch (e) { console.error('job task crashed', e); } finally { inFlight.delete(id); }
          })(),
        };
        inFlight.set(id, entry);
      }
      if (inFlight.size === 0) break;
      await Promise.race([...[...inFlight.values()].map((v) => v.task), nextWake()]);
    }
  } catch (e) {
    console.error('job loop crashed', e);
  } finally {
    loopRunning = false;
  }
}

// ---------------------------------------------------------------------------
// 按用途选模型（§2.1 第 2 条）
// ---------------------------------------------------------------------------

async function resolveStepProvider(job: Pick<Job, 'params' | 'providerId'>, purpose: StepPurpose, global: StepProviderMap): Promise<LLMProvider> {
  const id = pickProviderId(purpose, { job: providerMapOf(job.params), global, jobProviderId: job.providerId });
  if (id) return providerById(id);
  return (await providerForPurpose(basePurposeOf(purpose))).provider;
}

/** 供 UI 预估费用用：这个任务/这本书每种用途实际会用哪个模型。 */
export async function providersForPurposes(job: Pick<Job, 'params' | 'providerId'>, purposes: readonly StepPurpose[]): Promise<Record<string, LLMProvider>> {
  const global = await getSetting<StepProviderMap>('stepProviderId', {});
  const out: Record<string, LLMProvider> = {};
  for (const p of purposes) out[p] = await resolveStepProvider(job, p, global);
  return out;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}

async function assistantMayRun(job:Job):Promise<boolean> {
  if(typeof job.params.assistantRunId!=='string') return true;
  const run=await getAssistantRun(job.params.assistantRunId);
  if(run?.state==='waiting_job' && run.jobId===job.id) return true;
  await setJobStatus(job.id,run?.state==='cancelled'?'cancelled':'paused');
  return false;
}

async function processOne(job: Job): Promise<void> {
  if(job.status==='running' && !await assistantMayRun(job)) {await emitJob(job.id);return;}
  if (job.status === 'pausing') { await finalize(job.id, 'paused'); return; }
  if (job.status === 'cancelling') { await finalize(job.id, 'cancelled'); return; }
  const step = await nextPendingStep(job.id);
  if (!step) {
    const failed = (await listSteps(job.id)).some((s) => s.status === 'failed' || s.status === 'skipped' && isRequiredStep(s.kind));
    await finalize(job.id, failed ? 'failed' : 'completed');
    return;
  }
  const handler = STEP_HANDLERS[step.kind];
  if (!handler) { await stepFailed(step.id, `Missing step handler: ${step.kind}`); await setJobStatus(job.id,'failed',{error:`Missing step handler: ${step.kind}`}); await emitStep(step.id); await emitJob(job.id); return; }

  const ac = new AbortController();
  controllers.set(job.id, ac);
  await stepStarted(step.id);
  const started = (await getStep(step.id)) ?? step;
  await updateProgress(job.id, { currentStepId: step.id, message: '', charsSoFar: await novelCharCount(job.novelId) });
  await emitStep(step.id);
  await emitJob(job.id);

  let lastFlush = 0;
  let lastEmit = 0;
  let pendingText = '';
  const purpose = STEP_PURPOSE[step.kind];
  const globalMap = await getSetting<StepProviderMap>('stepProviderId', {});
  const providerCache = new Map<StepPurpose, LLMProvider>();
  const providerFor = async (p: StepPurpose): Promise<LLMProvider> => {
    const hit = providerCache.get(p);
    if (hit) return hit;
    const resolved = await resolveStepProvider(job, p, globalMap);
    const topicTree=resolved.id==='server:lunaroute' ? await topicMemoryScope(job,started,p) : undefined;
    const bound: LLMProvider = { id: resolved.id, model: resolved.model, kind: resolved.kind, caps: resolved.caps,
      stream: async function* (request) {
        // Admission alone cannot enforce a budget across a long-running work.
        await assertBudget(job.novelId);
        request.signal?.throwIfAborted();
        const { storyDirectionContext } = await import('@/db/repos/storyOptionsRepo');
        const directions = await storyDirectionContext(job.novelId);
        const messages=[...request.messages, ...(directions ? [{role:'user' as const,content:directions}] : []), ...(job.params.assistantRunId ? [{role:'user' as const,content:`Author's authorized task goal: ${String(job.params.assistantGoal??'')}\nTask constraints: ${JSON.stringify(job.params.assistantConstraints??[])}`}] : [])];
        if((job.params.assistantRunId || directions) && estimateMessagesTokens(messages,resolved.caps.cjkTokenRatio)+request.maxTokens+(resolved.caps.reasoningTokens??0)+1500>resolved.caps.contextWindow) throw new Error('Required task constraints exceed the model window');
        yield* resolved.stream({ ...request,messages, ...(topicTree?{topicTree}:{}), binding: {
        operationId: `${job.id}:${started.id}:${p}`,
        candidateVersionId: typeof started.input.candidateVersionId === 'string' ? started.input.candidateVersionId : null,
        contentHash: typeof started.input.candidateHash === 'string' ? started.input.candidateHash : null,
        dependencyHash: typeof started.input.dependencyHash === 'string' ? started.input.dependencyHash : null,
      } });
      },
    };
    providerCache.set(p, bound);
    return bound;
  };
  let provider:LLMProvider;
  try { provider=await providerFor(purpose); }
  catch(error) { controllers.delete(job.id); await stepFailed(step.id,describeStepError(error)); await setJobStatus(job.id,'failed',{error:describeStepError(error)}); await emitStep(step.id); await emitJob(job.id); return; }
  let seedTaken = false;

  const ctx: StepContext = {
    commit: assistantJobWriter(job,started,ac.signal),
    job,
    step: started,
    purpose,
    provider,
    gate: taskGate(provider.id),
    signal: ac.signal,
    providerFor,
    recordUsage: async (usage: Usage, opts) => {
      const p = opts?.provider ?? provider;
      await recordUsageEvent({
        usage, purpose: opts?.purpose ?? purpose, model: p.model, providerKind: p.kind, providerId: p.id,
        novelId: job.novelId, jobId: job.id, stepId: step.id,
      }).catch((e) => console.error('记录用量失败', e));
    },
    takeResumeSeed: () => {
      if (seedTaken) return null;
      seedTaken = true;
      return started.partialText;
    },
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
    if(e instanceof LLMError && e.usage) {
      const entry=[...providerCache.entries()].find(([,p])=>p.id===e.providerId);
      await ctx.recordUsage(e.usage,{purpose:entry?.[0] ?? purpose,provider:entry?.[1] ?? provider});
    }
    const failureMessage=e instanceof Error ? e.message:String(e);
    if (e instanceof AwaitingReviewError || failureMessage.startsWith('Concurrent modification:')) {
      if (e instanceof AwaitingReviewError) {
        const current = await getStep(step.id);
        if (current) await setStepInput(step.id, {...current.input, awaitingAction:e.action ?? null});
      }
      if(pendingText) await stepPartial(step.id,pendingText);
      await stepFailed(step.id, failureMessage);
      await setJobStatus(job.id, 'awaiting_review', { error: failureMessage });
      await updateProgress(job.id, { message: failureMessage });
      // Approval can arrive just before the handler records its review checkpoint.
      const proposalId = (await getStep(step.id))?.input.planProposalId;
      if (typeof proposalId === 'string') await recoverAcceptedPlanJobs(proposalId);
      else if (step.kind === 'scene_plan') await recoverAcceptedPlanJobs();
      await emitStep(step.id);
      await emitJob(job.id);
      return;
    }
    const aborted = (e instanceof LLMError && e.kind === 'aborted') || (e instanceof Error && e.name === 'AbortError') || ac.signal.aborted;
    if (aborted) {
      await stepReset(step.id);
      if (pendingText) await stepPartial(step.id, pendingText);
    } else {
      const msg = describeStepError(e);
      console.error('step failed', step.kind, msg);
      // 步骤级自动重试（§2.1 第 6 条）：attempts 终于派上用场。
      const autoRetries = await getSetting<number>('stepAutoRetries', DEFAULT_STEP_AUTO_RETRIES);
      const decision = decideStepFailure({ attempts: started.attempts, autoRetries, retryable: isRetryableStepError(e) });
      if (decision.kind === 'retry') {
        if (pendingText) await stepPartial(step.id, pendingText);
        await stepReset(step.id);
        await updateProgress(job.id, { message: `${msg}（第 ${decision.attempt} 次失败，${Math.round(decision.delayMs / 1000)} 秒后自动重试）` });
        await emitJob(job.id);
        await sleep(decision.delayMs, ac.signal);
      } else {
        await stepFailed(step.id, msg);
        const cur = await getJob(job.id);
        if (cur && cur.status === 'running') await setJobStatus(job.id, transition('running', 'stepFailed'), { error: msg });
        if (step.chapterId) await setChapterStatus(step.chapterId, 'planned').catch(() => undefined);
      }
    }
  } finally {
    controllers.delete(job.id);
    await emitStep(step.id);
    await emitJob(job.id);
  }
}

/** 把技术错误翻成用户看得懂的一句话（超时最常见，单独点名）。 */
export function describeStepError(e: unknown): string {
  if (isTimeoutError(e)) return '供应商长时间没有返回内容（已超时）';
  if (e instanceof LLMError) {
    if (e.kind === 'auth') return `身份验证失败：${e.message}`;
    if (e.kind === 'context_length') return `上下文超出模型窗口：${e.message}`;
    if (e.kind === 'rate_limit') return `触发了供应商限流：${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}

async function finalize(jobId: string, status: JobStatus): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;
  if(status==='completed' && typeof job.params.assistantRunId==='string') {
    const run=await getAssistantRun(job.params.assistantRunId);
    if(run?.state!=='waiting_job') {
      await setJobStatus(jobId,run?.state==='cancelled'?'cancelled':'paused');
      await emitJob(jobId);return;
    }
  }
  if (job.status !== status) await setJobStatus(jobId, status);
  // 规划任务（大纲 / 章节表）跑完时小说还没开始写，状态该留在 planning。
  const isPlanning = (job.params as { stage?: unknown }).stage === 'plan';
  if (status === 'completed' && !isPlanning) {
    const novel = await getNovel(job.novelId);
    if (novel) {
      const chapters = await listChapters(novel.id);
      const allWritten = chapters.length > 0 && chapters.every((c) => c.committedVersionId && c.currentVersionId === c.committedVersionId && c.memoryStatus === 'valid');
      const lastStep=(await listSteps(job.id)).at(-1);
      const commit=lastStep ? assistantJobWriter(job,lastStep,new AbortController().signal) : undefined;
      await updateNovel(novel.id, { status: allWritten ? 'complete' : 'writing' },commit);
    }
  }
  await emitJob(jobId);
}

export async function pauseJob(id: string, commit:AtomicWriter=writeAtomic): Promise<void> {
  const job = await getJob(id);
  if (!job) throw new Error('Task is unavailable');
  if (['queued','awaiting_review'].includes(job.status)) {
    await setJobStatus(id,'paused',{},commit);
    await emitJob(id);
    return;
  }
  if (job.status !== 'running') {await commit([]);return;}
  await setJobStatus(id, transition(job.status, 'pause'),{},commit);
  controllers.get(id)?.abort();
  await emitJob(id);
  kick();
}

async function resetReviewChain(step: JobStep): Promise<void> {
  const chain = ['style_check','summarize','commit_chapter'];
  const steps = await listSteps(step.jobId);
  const targets = chain.includes(step.kind) ? steps.filter(s => s.chapterId === step.chapterId && chain.includes(s.kind)) : [step];
  for (const s of targets) {
    await setStepInput(s.id, { ...s.input, dependencyHash:null, candidateVersionId:null, candidateHash:null });
    await stepReset(s.id);
  }
}

export async function resumeJob(id: string, commit:AtomicWriter=writeAtomic): Promise<void> {
  const job = await getJob(id);
  if (!job) throw new Error('Task is unavailable');
  if (['paused', 'failed', 'awaiting_review'].includes(job.status)) assertJobMayResume(job, await listJobs({ novelId: job.novelId }));
  if (['paused', 'failed', 'awaiting_review'].includes(job.status)) await reconcileGenerationPlan(job);
  if (job.status === 'paused') {
    // Explicit resume after an author edit starts a fresh mandatory review chain.
    // Never carry the previous candidate's review or fact extraction forward.
    for (const step of await listSteps(id)) {
      if (step.status !== 'pending' || !step.chapterId || !['style_check','summarize','commit_chapter'].includes(step.kind) || !step.input.dependencyHash) continue;
      const chapter = await getChapter(step.chapterId);
      if (chapter && step.input.candidateVersionId !== chapter.currentVersionId) await resetReviewChain(step);
    }
    await setJobStatus(id, transition('paused', 'resume'), { interrupted: false },commit);
  }
  else if (job.status === 'failed' || job.status === 'awaiting_review') {
    for (const s of await listSteps(id)) if (s.status === 'failed') await resetReviewChain(s);
    await setJobStatus(id, transition('failed', 'retry'), { error: null },commit);
  } else {await commit([]);return;}
  await emitJob(id);
  kick();
}

export async function skipFailedStep(id: string): Promise<void> {
  const job = await getJob(id);
  if (!job || job.status !== 'failed') return;
  assertJobMayResume(job, await listJobs({ novelId: job.novelId }));
  const failed = (await listSteps(id)).filter(s => s.status === 'failed');
  if (failed.some(s => isRequiredStep(s.kind))) throw new Error('必需审查和提交步骤不能跳过');
  for (const s of failed) await stepSkipped(s.id);
  await setJobStatus(id, 'running', { error: null });
  await emitJob(id);
  kick();
}

// ---------------------------------------------------------------------------
// 单步重试 / 单步跳过（§2.1 第 6 条）
// ---------------------------------------------------------------------------

/** 该步骤现在能不能单独重试 / 跳过。 */
export function canActOnStep(job: Pick<Job, 'status'>, step: Pick<JobStep, 'status'>): boolean {
  if (step.status !== 'failed' && step.status !== 'skipped') return false;
  return ['failed', 'paused', 'completed', 'running', 'awaiting_review'].includes(job.status);
}

/** 把一个失败（或已跳过）的步骤放回队列，只重跑它。 */
export async function retryStep(stepId: string): Promise<void> {
  const step = await getStep(stepId);
  if (!step) return;
  const job = await getJob(step.jobId);
  if (!job || !canActOnStep(job, step)) return;
  assertJobMayResume(job, await listJobs({ novelId: job.novelId }));
  await resetReviewChain(step);
  const stillFailed = (await listSteps(job.id)).some((s) => s.status === 'failed');
  if (!['running', 'pausing', 'cancelling'].includes(job.status)) {
    await setJobStatus(job.id, 'running', { error: stillFailed ? job.error : null });
  } else if (!stillFailed && job.error) {
    await setJobStatus(job.id, job.status, { error: null });
  }
  await emitStep(stepId);
  await emitJob(job.id);
  kick();
}

/** 跳过一个失败的步骤，任务接着往下走。 */
export async function skipStep(stepId: string): Promise<void> {
  const step = await getStep(stepId);
  if (!step) return;
  const job = await getJob(step.jobId);
  if (!job || step.status !== 'failed') return;
  await stepSkipped(stepId);
  const stillFailed = (await listSteps(job.id)).some((s) => s.status === 'failed');
  if (!['running', 'pausing', 'cancelling'].includes(job.status)) {
    await setJobStatus(job.id, 'running', { error: stillFailed ? job.error : null });
  }
  const counts = await stepCounts(job.id);
  await updateProgress(job.id, { done: counts.done, total: counts.total });
  await emitStep(stepId);
  await emitJob(job.id);
  kick();
}

export async function cancelJob(id: string, commit:AtomicWriter=writeAtomic): Promise<void> {
  const job = await getJob(id);
  if (!job) throw new Error('Task is unavailable');
  if (job.status === 'running') { await setJobStatus(id, 'cancelling',{},commit); controllers.get(id)?.abort(); }
  else if (['queued', 'paused', 'failed', 'pausing', 'awaiting_review'].includes(job.status)) { await setJobStatus(id, 'cancelled',{},commit); controllers.get(id)?.abort(); }
  else {await commit([]);return;}
  await emitJob(id);
  kick();
}

export function isJobActive(id: string): boolean {
  return controllers.has(id);
}

/** Drain this job only; unrelated work can keep running. */
export async function waitForJobIdle(id:string):Promise<void> {
  const task=inFlight.get(id)?.task;
  if(task) await task;
  const job=await getJob(id);
  if(job?.status==='pausing') await finalize(id,'paused');
  else if(job?.status==='cancelling') await finalize(id,'cancelled');
}

/** Stop scheduling and drain in-flight database writes before replacing the database. */
export async function suspendJobRunnerForRestore():Promise<void> {
  suspendedForRestore=true;
  for(const job of await listJobs({statuses:['running','queued']})) await setJobStatus(job.id,'pausing');
  for(const controller of controllers.values()) controller.abort();
  if(wake) {wake();wake=null;}
  await Promise.all([...inFlight.values()].map(v=>v.task));
  for(const job of await listJobs({statuses:['pausing']})) await setJobStatus(job.id,'paused');
}

/** Await the scheduler as well as request controllers before a DB owner closes its connection. */
export async function waitForJobRunnerIdle():Promise<void> {
  while(loopRunning || inFlight.size) {
    if(inFlight.size) await Promise.all([...inFlight.values()].map(v=>v.task));
    else await new Promise(resolve=>setTimeout(resolve,10));
  }
}
