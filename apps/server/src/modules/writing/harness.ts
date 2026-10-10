import { runTopicTreeSession, MAX_TOPIC_MODEL_CALLS } from './topic-tree/session';
import { runPiInference } from './piInference';
import { and, asc, desc, eq, gt, lt, lte, or, sql } from 'drizzle-orm';
import { sha256Hex, type HarnessRequest, type HarnessTask, HarnessRequestSchema } from '@the-water/shared';
import { OpenAICompatibleProvider } from '@the-water/llm/openaiCompatible';
import { LLMError, type FetchLike, type StreamEvent } from '@the-water/llm/types';
import { estimateMessagesTokens } from '@the-water/llm/tokens';
import type { AppDeps } from '../../context';
import { users, writingTasks, writingTaskEvents, writingMemorySessions } from '../../db/schema';
import { conflict, notFound, validation, ApiError } from '../../lib/errors';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const LEASE_MS = 30_000;
export class WritingHarness {
  private readonly workerId = Bun.randomUUIDv7();
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  readonly provider: OpenAICompatibleProvider;

  constructor(private readonly deps: AppDeps, private readonly fetchImpl: FetchLike = fetch) {
    const env = deps.env;
    if (!env.writingHarnessEnabled || !env.lunarouteApiKey) throw new Error('Writing harness is not configured');
    // Address, headers, model and reasoning level are developer-controlled, never request fields.
    this.provider = new OpenAICompatibleProvider({
      id: 'server:lunaroute', name: 'Lunaroute', kind: 'openai_compatible',
      baseUrl: 'https://gw.lunaroute.com/v1', model: env.writingModel,
      contextWindow: 1048576, maxOutputTokens: env.writingMaxOutputTokens,
      reasoningTokens: env.writingReasoningTokens, reasoningEffort: env.writingReasoningEffort,
      jsonMode: env.writingJsonMode, temperature: 0.8, extraHeaders: {}, secretRef: '',
      firstByteTimeoutMs: 120000, idleTimeoutMs: 180000,
      isDefault: true, createdAt: 0, updatedAt: 0,
    }, env.lunarouteApiKey, fetchImpl);

  }

  capabilities() {
    const env = this.deps.env;
    return { enabled: true, engine: 'pi' as const, protocolVersion: 1 as const,
      provider: 'lunaroute', model: this.provider.model, contextWindow: this.provider.caps.contextWindow,
      maxOutputTokens: this.provider.caps.maxOutputTokens, reasoningTokens: env.writingReasoningTokens,
      reasoningEffort: env.writingReasoningEffort, jsonMode: env.writingJsonMode, retentionHours: env.writingRetentionHours,
      topicTree: {enabled:true,version:'0.2.0',maxModelCalls:MAX_TOPIC_MODEL_CALLS,scopeRequired:true as const} };
  }

  async create(userId: string, key: string, input: HarnessRequest): Promise<HarnessTask> {
    if (!/^[a-zA-Z0-9:_-]{8,200}$/.test(key)) throw validation('需要有效的 Idempotency-Key');
    const request = HarnessRequestSchema.parse(input);
    const bytes = new TextEncoder().encode(JSON.stringify(request)).length;
    if (bytes > 2 * 1024 * 1024) throw validation('模型上下文超过 2 MiB 请求上限；未删减任何资料');
    if (request.maxTokens + this.deps.env.writingReasoningTokens > this.provider.caps.maxOutputTokens) throw validation('正文输出与推理预留超过供应商单次输出容量');
    if (estimateMessagesTokens(request.messages, 0.7) + request.maxTokens + this.deps.env.writingReasoningTokens + 1500 > this.provider.caps.contextWindow) throw validation('必需上下文无法装入模型窗口；未删减任何资料');
    if (request.topicTree && !request.binding) throw validation('主题会话需要版本绑定');
    const sessionKey = request.topicTree ? await sha256Hex(JSON.stringify([userId,request.topicTree.workId,request.topicTree.branchId,request.topicTree.channel,request.topicTree.epoch])) : null;
    const hash = await sha256Hex(JSON.stringify({ request, model: this.provider.model, caps: this.capabilities() }));
    const now = this.deps.clock.now().getTime();
    const id = this.deps.db.transaction(tx => {
      const existing = tx.select().from(writingTasks).where(and(eq(writingTasks.userId, userId), eq(writingTasks.idempotencyKey, key))).get();
      if (existing) {
        if (existing.requestHash !== hash) throw conflict('幂等键已用于不同输入或服务配置');
        return existing.id;
      }
      const pending = tx.select({ count: sql<number>`count(*)` }).from(writingTasks).where(and(eq(writingTasks.userId, userId), sql`${writingTasks.status} IN ('queued','running')`)).get()!.count;
      if (pending >= 20) throw new ApiError('RATE_LIMITED', '待处理模型任务过多', { retryAfterMs: 1000 });
      const newId = Bun.randomUUIDv7();
      tx.insert(writingTasks).values({ id: newId, userId, idempotencyKey: key, requestHash: hash, request,
        sessionKey, binding: request.binding ?? null, status: 'queued', provider: 'lunaroute', model: this.provider.model,
        createdAt: now, expiresAt: now + this.deps.env.writingRetentionHours * 3600000 }).run();
      return newId;
    }, { behavior: 'immediate' });
    return this.get(userId, id);
  }

  get(userId: string, id: string): HarnessTask {
    const row = this.deps.db.select().from(writingTasks).where(and(eq(writingTasks.id, id), eq(writingTasks.userId, userId))).get();
    if (!row) throw notFound('模型任务');
    if (row.expiresAt <= this.deps.clock.now().getTime()) throw notFound('模型任务（已过保留期）');
    return { id: row.id, requestHash: row.requestHash, status: row.status, provider: row.provider, model: row.model,
      binding: row.binding ?? undefined, createdAt: row.createdAt, expiresAt: row.expiresAt, error: row.error, usage: row.usage };
  }

  page(userId: string, id: string, after: number) {
    const task = this.get(userId, id);
    const rows = this.deps.db.select().from(writingTaskEvents).where(and(eq(writingTaskEvents.taskId, id), gt(writingTaskEvents.seq, after))).orderBy(asc(writingTaskEvents.seq)).limit(101).all();
    return { task, events: rows.slice(0, 100).map(r => ({ seq: r.seq, event: r.event })), hasMore: rows.length > 100 };
  }

  cancel(userId: string, id: string) {
    const task = this.get(userId, id);
    if (!TERMINAL.has(task.status)) {
      this.deps.db.update(writingTasks).set({ status: 'cancelled', request: null, error: { kind: 'aborted', message: '任务已取消' } }).where(and(eq(writingTasks.id, id), sql`${writingTasks.status} IN ('queued','running')`)).run();
      this.active.get(id)?.controller.abort();
    }
    return this.get(userId, id);
  }

  /** Start queue polling independently of HTTP clients. Single SQLite DB is the claim authority. */
  start() {
    const tick = () => { try { this.tick(); } catch { console.error('[writing-queue] claim failed; tasks retained for retry'); } };
    this.timer ??= setInterval(tick, 500); tick();
  }
  tick() {
    if (this.stopped) return;
    const now = this.deps.clock.now().getTime();
    this.deps.db.update(writingTasks).set({ status: 'interrupted', workerId: null, leaseUntil: null, request: null,
      error: { kind: 'network', message: '服务进程中断；上游执行结果未知，请明确重试，不会自动重复调用' } }).where(and(eq(writingTasks.status, 'running'), lte(writingTasks.leaseUntil, now))).run();
    for (;;) {
      const row = this.deps.db.transaction(tx => {
        const occupied = tx.select({ count: sql<number>`count(*)` }).from(writingTasks).where(gt(writingTasks.leaseUntil, now)).get()!.count;
        if (occupied >= this.deps.env.writingConcurrency) return null;
        const next = tx.select().from(writingTasks).where(and(eq(writingTasks.status, 'queued'), sql`(${writingTasks.sessionKey} IS NULL OR NOT EXISTS (SELECT 1 FROM writing_tasks busy WHERE busy.session_key = ${writingTasks.sessionKey} AND busy.status = 'running'))`)).orderBy(asc(writingTasks.createdAt)).limit(1).get();
        if (!next) return null;
        tx.update(writingTasks).set({ status: 'running', workerId: this.workerId, leaseUntil: now + LEASE_MS }).where(and(eq(writingTasks.id, next.id), eq(writingTasks.status, 'queued'))).run();
        return next;
      }, { behavior: 'immediate' });
      if (!row) break;
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => this.infer(row.id)).catch(() => {
        // Never log upstream raw errors: providers can echo credentials or private prompts.
        this.deps.db.update(writingTasks).set({ status: 'failed', request: null,
          error: { kind: 'server', message: '工作流执行失败；未提交正文' } }).where(and(eq(writingTasks.id, row.id), eq(writingTasks.status, 'running'), eq(writingTasks.workerId, this.workerId))).run();
      }).finally(() => {
        this.deps.db.update(writingTasks).set({ workerId: null, leaseUntil: null }).where(and(eq(writingTasks.id, row.id), eq(writingTasks.workerId, this.workerId))).run();
        this.active.delete(row.id);
      });
      this.active.set(row.id, { controller, promise });
    }
  }

  async drain() { await Promise.all([...this.active.values()].map(v => v.promise)); }
  async ready() { this.deps.db.select({ id: writingTasks.id }).from(writingTasks).limit(1).all(); }
  async close() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const task of this.active.values()) task.controller.abort();
    await this.drain();
  }

  async gc() {
    const expired = this.deps.db.select({ id: writingTasks.id }).from(writingTasks).where(and(lte(writingTasks.expiresAt, this.deps.clock.now().getTime()), sql`${writingTasks.status} NOT IN ('running')`, sql`${writingTasks.workerId} IS NULL`)).all();
    this.deps.db.delete(writingMemorySessions).where(lte(writingMemorySessions.expiresAt,this.deps.clock.now().getTime())).run();
    const legacy = this.deps.db.get(sql`SELECT name FROM sqlite_master WHERE type='table' AND name='mastra_workflow_snapshot'`);
    for (const row of expired) {
      this.deps.db.transaction(tx => {
        if (legacy) tx.run(sql`DELETE FROM mastra_workflow_snapshot WHERE workflow_name='writing-inference' AND run_id=${row.id}`);
        tx.delete(writingTasks).where(eq(writingTasks.id, row.id)).run();
      });
    }
  }

  private async infer(id: string) {
    const { db, clock } = this.deps;
    const row = db.select().from(writingTasks).where(eq(writingTasks.id, id)).get();
    const active = this.active.get(id);
    if (!row?.request || !active || row.status !== 'running') throw new Error('Task is not active');
    const requestHash = await sha256Hex(JSON.stringify({ request: row.request, model: this.provider.model, caps: this.capabilities() }));
    if (requestHash !== row.requestHash || row.expiresAt <= clock.now().getTime()) {
      db.update(writingTasks).set({ status: 'failed', request: null,
        error: { kind: 'bad_request', message: '服务配置已变化或输入已过保留期，请重新提交；未调用上游' } }).where(eq(writingTasks.id, id)).run();
      return;
    }
    const owner = db.select().from(users).where(eq(users.id, row.userId)).get();
    if (!owner || owner.deletedAt || !owner.emailVerifiedAt || owner.status !== 'active') {
      db.update(writingTasks).set({ status: 'failed', request: null, error: { kind: 'auth', message: '账号不可执行模型任务' } }).where(eq(writingTasks.id, id)).run();
      return;
    }
    let seq = 0, buffer = '', lastFlush = Date.now(), outputChars = 0, done = false;
    let reportedInput: number | null = null, reportedOutput: number | null = null;
    const emit = (event: StreamEvent) => {
      db.transaction(tx => {
        const task = tx.select({ status: writingTasks.status, workerId: writingTasks.workerId }).from(writingTasks).where(eq(writingTasks.id, id)).get();
        if (task?.status !== 'running' || task.workerId !== this.workerId) throw new LLMError('aborted', 'Task is no longer active');
        tx.insert(writingTaskEvents).values({ taskId: id, seq: ++seq, event }).run();
        if (event.type === 'usage') {
          if(event.inputReported!==false) reportedInput=event.inputTokens; else if(event.cumulative) reportedInput=null;
          if(event.outputReported!==false) reportedOutput=event.outputTokens; else if(event.cumulative) reportedOutput=null;
          tx.update(writingTasks).set({ usage: reportedInput !== null && reportedOutput !== null ? { inputTokens: reportedInput, outputTokens: reportedOutput } : null }).where(eq(writingTasks.id, id)).run();
        }
      });
    };
    const flush = () => { if (buffer) { emit({ type: 'delta', text: buffer }); buffer = ''; lastFlush = Date.now(); } };
    const heartbeat = setInterval(() => {
      const state = db.select().from(writingTasks).where(eq(writingTasks.id, id)).get();
      const owner = db.select().from(users).where(eq(users.id, row.userId)).get();
      if (!owner || owner.deletedAt || !owner.emailVerifiedAt || owner.status !== 'active') {
        db.update(writingTasks).set({ status: 'cancelled', request: null, error: { kind: 'auth', message: '账号不再允许执行模型任务' } }).where(and(eq(writingTasks.id, id), eq(writingTasks.status, 'running'))).run();
        active.controller.abort();
      } else if (state?.status !== 'running' || state.workerId !== this.workerId || state.expiresAt <= clock.now().getTime()) active.controller.abort();
      else db.update(writingTasks).set({ leaseUntil: clock.now().getTime() + LEASE_MS }).where(and(eq(writingTasks.id, id), eq(writingTasks.workerId, this.workerId))).run();
    }, 2000);
    try {
      const onEvent = (event: StreamEvent) => {
        if (event.type === 'delta') {
          outputChars += event.text.length;
          if (outputChars > 2_000_000) throw new LLMError('bad_request', '模型输出超过保留容量');
          buffer += event.text;
          if (buffer.length >= 2000 || Date.now() - lastFlush > 100) flush();
        } else {
          flush();
          if (event.type === 'done' && event.finishReason !== 'stop' && event.finishReason !== 'length') throw new LLMError('bad_request', '模型未正常完成文本响应');
          emit(event); if (event.type === 'done') done = true;
        }
      };
      let memory: Awaited<ReturnType<typeof runTopicTreeSession>> | undefined;
      let versionKey = '';
      if (row.request.topicTree && row.sessionKey) {
        const scope=row.request.topicTree;
        versionKey=await sha256Hex(JSON.stringify([row.binding?.candidateVersionId,row.binding?.contentHash,row.binding?.dependencyHash]));
        const previous=db.select().from(writingMemorySessions).where(and(eq(writingMemorySessions.userId,row.userId),eq(writingMemorySessions.sessionKey,row.sessionKey),gt(writingMemorySessions.expiresAt,clock.now().getTime()),or(lt(writingMemorySessions.chapterNo,scope.chapterNo),and(eq(writingMemorySessions.chapterNo,scope.chapterNo),eq(writingMemorySessions.versionKey,versionKey))))).orderBy(desc(writingMemorySessions.chapterNo),desc(writingMemorySessions.updatedAt)).limit(1).get();
        memory=await runTopicTreeSession({env:this.deps.env,request:row.request,entries:previous?.entries,signal:active.controller.signal,fetchImpl:this.fetchImpl,emit:onEvent});
      } else await runPiInference(this.provider,{...row.request,signal:active.controller.signal},onEvent);
      flush();
      if (!done) throw new LLMError('network', '模型流未完整结束');
      db.transaction(tx=>{
        const current=tx.select().from(writingTasks).where(eq(writingTasks.id,id)).get();
        if(current?.status!=='running'||current.workerId!==this.workerId||active.controller.signal.aborted) throw new LLMError('aborted','任务已取消；不提交主题记忆');
        if(memory && row.request?.topicTree && row.sessionKey) {
          const key=memorySnapshotKey(row.sessionKey,row.request.topicTree.chapterNo,versionKey);
          const now=clock.now().getTime();
          tx.insert(writingMemorySessions).values({key,sessionKey:row.sessionKey,userId:row.userId,chapterNo:row.request.topicTree.chapterNo,versionKey,entries:memory,updatedAt:now,expiresAt:now+this.deps.env.writingMemoryRetentionDays*86400000}).onConflictDoUpdate({target:writingMemorySessions.key,set:{entries:memory,updatedAt:now,expiresAt:now+this.deps.env.writingMemoryRetentionDays*86400000,revision:sql`${writingMemorySessions.revision}+1`}}).run();
        }
        tx.update(writingTasks).set({status:'completed',request:null}).where(eq(writingTasks.id,id)).run();
      },{behavior:'immediate'});
    } catch (error) {
      // Keep real reported usage and partial output, but never treat them as a successful response.
      const kind = error instanceof LLMError ? error.kind : 'server';
      db.update(writingTasks).set({ status: active.controller.signal.aborted ? 'interrupted' : 'failed', request: null,
        error: { kind, message: kind === 'auth' ? '服务端模型认证失败，请联系开发者' : `模型请求失败（${kind}）；未提交正文`,
          ...(error instanceof LLMError && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) } }).where(and(eq(writingTasks.id, id), eq(writingTasks.status, 'running'), eq(writingTasks.workerId, this.workerId))).run();
    } finally { clearInterval(heartbeat); }
  }
}

function memorySnapshotKey(sessionKey:string,chapterNo:number,versionKey:string) { return `${sessionKey}:${chapterNo}:${versionKey}`; }
