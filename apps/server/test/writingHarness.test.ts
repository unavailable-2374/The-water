import { afterEach, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { HarnessTaskSchema, HarnessPageSchema, HarnessCapabilitiesSchema } from '@the-water/shared';
import { WritingHarness } from '../src/modules/writing/harness';
import { writingTasks, writingMemorySessions, users } from '../src/db/schema';
import { makeTestApp } from './helpers';
import { loadEnv } from '../src/env';
import type { FetchLike } from '@the-water/llm/types';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';

// TEST SIMULATED vendor transport. These are contract tests, never literary quality evidence.
function topicMaintenanceResponse(body:any):Response|undefined {
 const system=body.messages[0]?.content;
 let content:string|undefined;
 if(typeof system==='string' && system.includes('You maintain a topic tree')) content=JSON.stringify({newTopics:[{ref:'n1',title:'TEST history',parent:null}],assignments:[...body.messages.at(-1).content.matchAll(/<turn index="(\d+)">/g)].map((m:any)=>({turn:Number(m[1]),topics:['n1']})),globalFacts:[]});
 if(typeof system==='string' && system.includes('running summary')) content='TEST historical summary';
 return content===undefined ? undefined : new Response(`data: ${JSON.stringify({choices:[{index:0,delta:{content},finish_reason:'stop'}],usage:{prompt_tokens:17,completion_tokens:23}})}\n\ndata: [DONE]\n\n`);
}
const live: WritingHarness[] = [];
afterEach(async () => { for (const h of live.splice(0)) await h.close(); });
function fixture(options: { fetch?: FetchLike; concurrency?: number } = {}) {
  const t = makeTestApp({ env: { writingHarnessEnabled: true, lunarouteApiKey: 'TEST-SIMULATED-SECRET', writingHarnessStorage: ':memory:', writingConcurrency: options.concurrency ?? 2 } });
  const calls: { url: string; headers: Headers; body: any }[] = [];
  const h = new WritingHarness(t.deps, options.fetch ?? (async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const maintenance=topicMaintenanceResponse(calls.at(-1)!.body);if(maintenance) return maintenance;
    const chunks = [
      { choices: [{ delta: { content: 'TEST 中文草稿' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 17, completion_tokens: 23 } },
    ];
    return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n');
  }));
  t.deps.writingHarness = h; live.push(h);
  return { ...t, h, calls };
}
const body = { messages: [{ role: 'user' as const, content: 'TEST PRIVATE PROMPT' }], maxTokens: 200,
  binding: { operationId: 'TEST-operation', candidateVersionId: 'TEST-v1', contentHash: 'a'.repeat(64), dependencyHash: 'b'.repeat(64) } };
const path = '/api/v1/writing/tasks';

describe('Pi backend harness (TEST SIMULATED)', () => {
  test('server configuration requires a developer key and preserves vendor capacity', () => {
    expect(() => loadEnv({ WRITING_HARNESS_ENABLED: '1' })).toThrow('requires LUNAROUTE_API_KEY');
    expect(() => loadEnv({ WRITING_MAX_OUTPUT_TOKENS: '1024', WRITING_REASONING_TOKENS: '1024' })).toThrow('must be smaller');
    expect(loadEnv({}).writingHarnessEnabled).toBe(false);
    expect(() => loadEnv({ WRITING_HARNESS_ENABLED: '1', LUNAROUTE_API_KEY: 'TEST key',
      DATABASE_URL: 'TEST-main.sqlite', WRITING_HARNESS_STORAGE: 'TEST-other.sqlite' }))
      .toThrow('Pi harness uses DATABASE_URL');
  });
  test('requires authentication, verified email, and owner-scoped reads/cancellation', async () => {
    const t = fixture();
    expect((await t.json('POST', path, { body, headers: { 'Idempotency-Key': 'TEST-request-1' } })).status).toBe(401);
    const a = await t.register('TEST-owner@example.com'), b = await t.register('TEST-other@example.com');
    t.deps.db.update(users).set({ emailVerifiedAt: null }).where(eq(users.id, a.user.id)).run();
    expect((await t.json('POST', path, { token: a.token, body, headers: { 'Idempotency-Key': 'TEST-request-1' } })).status).toBe(403);
    t.deps.db.update(users).set({ emailVerifiedAt: t.clock.now() }).where(eq(users.id, a.user.id)).run();
    const task = await t.h.create(a.user.id, 'TEST-request-1', body);
    expect((await t.json('GET', `${path}/${task.id}`, { token: b.token })).status).toBe(404);
    expect((await t.json('DELETE', `${path}/${task.id}`, { token: b.token })).status).toBe(404);
    expect(t.h.get(a.user.id, task.id).status).toBe('queued');
  });
  test('fixed upstream, actual reported usage, binding echo, replay and idempotent submission', async () => {
    const t = fixture(); const owner = await t.register('TEST-fixed@example.com');
    const send = () => t.json('POST', path, { token: owner.token, body, headers: { 'Idempotency-Key': 'TEST-fixed-key' } });
    const [a, b] = await Promise.all([send(), send()]);
    expect(a.status).toBe(202); expect(a.body.id).toBe(b.body.id); HarnessTaskSchema.parse(a.body);
    t.h.tick(); await t.h.drain();
    const result = await t.json('GET', `${path}/${a.body.id}`, { token: owner.token });
    HarnessPageSchema.parse(result.body);
    expect(result.body.task.status).toBe('completed'); expect(result.body.task.binding).toEqual(body.binding);
    expect(result.body.task.usage).toEqual({ inputTokens: 17, outputTokens: 23 });
    expect(result.body.events.map((e: any) => e.event.type)).toEqual(['delta', 'usage', 'done']);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.url).toBe('https://gw.lunaroute.com/v1/chat/completions');
    expect(t.calls[0]!.body.model).toBe('deepseek-4.1-flash'); expect(t.calls[0]!.body.reasoning_effort).toBe('low');
    expect(t.calls[0]!.body.max_tokens).toBe(32200);
    expect(JSON.stringify(result.body)).not.toContain('TEST-SIMULATED-SECRET');
    expect(t.deps.db.select().from(writingTasks).get()!.request).toBeNull();
    const after = await t.json('GET', `${path}/${a.body.id}?after=3`, { token: owner.token }); expect(after.body.events).toEqual([]);
    t.h.tick(); await t.h.drain(); expect(t.calls).toHaveLength(1);
    expect((await t.json('POST', path, { token: owner.token, body: { ...body, maxTokens: 201 }, headers: { 'Idempotency-Key': 'TEST-fixed-key' } })).status).toBe(409);
    const caps = await t.json('GET', '/api/v1/writing/capabilities', { token: owner.token }); HarnessCapabilitiesSchema.parse(caps.body); expect(caps.body.engine).toBe('pi');
    expect(JSON.stringify(caps.body)).not.toContain('TEST-SIMULATED-SECRET');
  });
  test('Pi preserves confirmed context and structured request controls without extra turns', async () => {
    const t = fixture(); const owner = await t.register('TEST-pi-context@example.com');
    const request = { ...body, messages: [
      { role: 'system' as const, content: 'TEST confirmed canon' },
      { role: 'user' as const, content: 'TEST previous question' },
      { role: 'assistant' as const, content: 'TEST previous answer' },
      { role: 'system' as const, content: 'TEST confirmed scene constraint' },
      { role: 'user' as const, content: 'TEST current question' },
    ], temperature: 0.6, stop: ['TEST STOP'], json: { name: 'TEST_review', schema: { type: 'object' } } };
    const task = await t.h.create(owner.user.id, 'TEST-pi-context', request);
    t.h.tick(); await t.h.drain();
    expect(t.h.get(owner.user.id, task.id).status).toBe('completed');
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.body.messages).toEqual(request.messages);
    expect(t.calls[0]!.body.stop).toEqual(request.stop);
    expect(t.calls[0]!.body.temperature).toBe(0.6);
    expect(t.calls[0]!.body.response_format.json_schema.schema).toEqual(request.json.schema);
  });
  test('Pi retention also clears matching legacy Mastra snapshots without touching unrelated workflows', async () => {
    const t = fixture(); const owner = await t.register('TEST-pi-legacy@example.com');
    t.deps.db.run(sql`CREATE TABLE mastra_workflow_snapshot (workflow_name TEXT, run_id TEXT, snapshot TEXT)`);
    const task = await t.h.create(owner.user.id, 'TEST-pi-legacy', body);
    t.deps.db.run(sql`INSERT INTO mastra_workflow_snapshot VALUES ('writing-inference',${task.id},'TEST legacy identity')`);
    t.deps.db.run(sql`INSERT INTO mastra_workflow_snapshot VALUES ('TEST unrelated','TEST other','TEST unrelated identity')`);
    t.h.tick(); await t.h.drain(); t.clock.advance(25 * 3600000); await t.h.gc();
    expect(t.deps.db.all(sql`SELECT run_id FROM mastra_workflow_snapshot`)).toEqual([{ run_id: 'TEST other' }]);
  });
  test('rejects upstream overrides, oversized output and malformed event cursor', async () => {
    const t = fixture(); const a = await t.register('TEST-validation@example.com');
    for (const input of [{ ...body, baseUrl: 'http://attacker.invalid' }, { ...body, model: 'other-model' }, { ...body, maxTokens: 262144 }]) {
      expect((await t.json('POST', path, { token: a.token, body: input, headers: { 'Idempotency-Key': 'TEST-invalid' } })).status).toBe(400);
    }
    expect((await t.json('GET', `${path}/TEST-missing?after=NaN`, { token: a.token })).status).toBe(400);
    expect(t.calls).toHaveLength(0);
  });
  test('truncated streams remain length and missing usage remains unknown', async () => {
    const t = fixture({ fetch: async () => new Response('data: {"choices":[{"delta":{"content":"TEST partial"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n') });
    const a = await t.register('TEST-length@example.com'); const task = await t.h.create(a.user.id, 'TEST-length', body);
    t.h.tick(); await t.h.drain();
    const page = t.h.page(a.user.id, task.id, 0);
    expect(page.task.usage).toBeNull();
    expect(page.events.at(-1)!.event).toEqual({ type: 'done', finishReason: 'length' });
  });
  test('provider error bodies cannot leak secrets or fake success', async () => {
    const t = fixture({ fetch: async () => new Response('TEST-SIMULATED-SECRET TEST PRIVATE PROMPT', { status: 401 }) });
    const a = await t.register('TEST-error@example.com'); const task = await t.h.create(a.user.id, 'TEST-error-key', body);
    t.h.tick(); await t.h.drain(); const page = t.h.page(a.user.id, task.id, 0);
    expect(page.task.status).toBe('failed'); expect(page.task.error!.kind).toBe('auth');
    expect(JSON.stringify(page)).not.toContain('TEST-SIMULATED-SECRET'); expect(JSON.stringify(page)).not.toContain('TEST PRIVATE PROMPT');
    expect(page.events.some(e => e.event.type === 'done')).toBe(false);
  });
  test('stale lease is interrupted without issuing another upstream request; queued cancellation is durable', async () => {
    const t = fixture(); const a = await t.register('TEST-crash@example.com');
    const task = await t.h.create(a.user.id, 'TEST-crash-key', body);
    t.deps.db.update(writingTasks).set({ status: 'running', workerId: 'TEST-dead-worker', leaseUntil: t.clock.now().getTime() - 1 }).where(eq(writingTasks.id, task.id)).run();
    t.h.tick(); await t.h.drain(); expect(t.h.get(a.user.id, task.id).status).toBe('interrupted'); expect(t.calls).toHaveLength(0);
    const cancelled = await t.h.create(a.user.id, 'TEST-cancel-key', body); t.h.cancel(a.user.id, cancelled.id);
    t.h.tick(); await t.h.drain(); expect(t.h.get(a.user.id, cancelled.id).status).toBe('cancelled'); expect(t.calls).toHaveLength(0);
  });
  test('expired private payloads are removed, never replayed', async () => {
    const t = fixture(); const a = await t.register('TEST-retention@example.com'); const task = await t.h.create(a.user.id, 'TEST-retention-key', body);
    t.h.tick(); await t.h.drain(); t.clock.advance(25 * 3600000); await t.h.gc();
    expect(t.deps.db.select().from(writingTasks).all()).toEqual([]);
    expect(() => t.h.get(a.user.id, task.id)).toThrow();
  });
  test('queued work and completed output survive reconstructing Pi with the actual disk store', async () => {
    const folder = mkdtempSync(join(homedir(), '.codex/validation/TEST-harness-'));
    const file = join(folder, 'TEST.sqlite'); const { db, sqlite } = createDb(file); runMigrations(db);
    const t = makeTestApp({ env: { writingHarnessEnabled: true, lunarouteApiKey: 'TEST-SIMULATED-SECRET', writingHarnessStorage: file } });
    t.deps.db = db;
    let current: WritingHarness | undefined;
    let calls = 0;
    const upstream: FetchLike = async () => { calls++; return new Response('data: {"choices":[{"delta":{"content":"TEST durable"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); };
    try {
      const registered = await t.json('POST', '/api/v1/auth/register', { body: { email: 'TEST-disk@example.com', password: 'TEST-password-123', displayName: 'TEST disk' } });
      expect(registered.status).toBe(201); const id = registered.body.user.id;
      db.update(users).set({ emailVerifiedAt: t.clock.now() }).where(eq(users.id, id)).run();
      current = new WritingHarness(t.deps, upstream); await current.ready();
      const task = await current.create(id, 'TEST-disk-key', body);
      await current.close(); current = new WritingHarness(t.deps, upstream); await current.ready();
      current.tick(); await current.drain(); expect(calls).toBe(1); expect(current.get(id, task.id).status).toBe('completed');
      await current.close(); current = new WritingHarness(t.deps, upstream); await current.ready();
      expect(current.page(id, task.id, 0).events[0]!.event).toEqual({ type: 'delta', text: 'TEST durable' });
      current.tick(); await current.drain(); expect(calls).toBe(1);
      const durable = db.select().from(writingTasks).where(eq(writingTasks.id, task.id)).get()!;
      expect(durable.request).toBeNull();
      expect(JSON.stringify(current.page(id, task.id, 0))).not.toContain('TEST PRIVATE PROMPT');
      expect(JSON.stringify(current.page(id, task.id, 0))).not.toContain('TEST-SIMULATED-SECRET');
    } finally { await current?.close(); sqlite.close(); rmSync(folder, { recursive: true, force: true }); }
  });
  test('two workers obey one shared concurrency limit and running cancellation aborts the upstream', async () => {
    let entered = 0;
    let unblock!: (value: Response) => void;
    const t = fixture({ concurrency: 1, fetch: async (_url, init) => {
      entered++;
      return new Promise<Response>((resolve, reject) => {
        unblock = resolve;
        init!.signal!.addEventListener('abort', () => reject(new DOMException('TEST aborted', 'AbortError')), { once: true });
      });
    } });
    const a = await t.register('TEST-concurrency@example.com');
    const one = await t.h.create(a.user.id, 'TEST-concurrency-1', body), two = await t.h.create(a.user.id, 'TEST-concurrency-2', body);
    const worker2 = new WritingHarness(t.deps, async () => { throw new Error('TEST second worker must not start'); }); live.push(worker2);
    t.h.tick(); worker2.tick();
    // Wait only for the deterministic TEST transport to enter, not a simulated program result.
    for (let i = 0; entered === 0 && i < 100; i++) await Bun.sleep(5);
    expect(entered).toBe(1); expect(t.h.get(a.user.id, two.id).status).toBe('queued');
    t.h.cancel(a.user.id, one.id); await t.h.drain(); expect(t.h.get(a.user.id, one.id).status).toBe('cancelled');
    t.h.tick(); for (let i = 0; entered < 2 && i < 100; i++) await Bun.sleep(5);
    expect(entered).toBe(2);
    unblock(new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    await t.h.drain(); expect(t.h.get(a.user.id, two.id).status).toBe('completed');
  });
  test('service configuration changes cannot execute stale queued inputs', async () => {
    const t = fixture(); const a = await t.register('TEST-config@example.com');
    const task = await t.h.create(a.user.id, 'TEST-config-key', body);
    t.deps.env.writingReasoningEffort = 'high';
    t.h.tick(); await t.h.drain();
    expect(t.h.get(a.user.id, task.id).status).toBe('failed'); expect(t.calls).toHaveLength(0);
  });
  test('missing finish reason is failed, never marked as completed', async () => {
    const t = fixture({ fetch: async () => new Response('data: {"choices":[{"delta":{"content":"TEST incomplete"},"finish_reason":null}]}\n\n') });
    const a = await t.register('TEST-eof@example.com'); const task = await t.h.create(a.user.id, 'TEST-eof-key', body);
    t.h.tick(); await t.h.drain(); expect(t.h.get(a.user.id, task.id).status).toBe('failed');
    expect(t.h.page(a.user.id, task.id, 0).events.some(e => e.event.type === 'done')).toBe(false);
  });
  test('partial usage reports do not fabricate zero for an unreported token counter', async () => {
    const t = fixture({ fetch: async () => new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":17}}\n\ndata: [DONE]\n\n') });
    const a = await t.register('TEST-partial-usage@example.com'); const task = await t.h.create(a.user.id, 'TEST-usage-key', body);
    t.h.tick(); await t.h.drain(); const page = t.h.page(a.user.id, task.id, 0);
    expect(page.task.status).toBe('completed'); expect(page.task.usage).toBeNull();
    expect(page.events[0]!.event).toEqual({ type: 'usage', inputTokens: 17, outputTokens: 0, outputReported: false });
  });
});

// TEST / SIMULATED transport, real SDK, real SQLite transactions and authentication.
describe('Pi topic-tree durable scope (TEST SIMULATED)',()=>{
 const scope={workId:'TEST-work',branchId:'adopted',channel:'writing',epoch:'c'.repeat(64),chapterNo:1};
 test('restores earlier chapters, serializes one session and isolates owner, branch, epoch, channel and rewind',async()=>{
  const t=fixture();const owner=await t.register('TEST-topic-owner@example.com');const other=await t.register('TEST-topic-other@example.com');
  const submit=async(n:number,overrides:Record<string,unknown>={},user=owner.user.id)=>{
   const request={...body,messages:[{role:'user' as const,content:`TEST isolated record ${n}`}],topicTree:{...scope,...overrides}};
   const task=await t.h.create(user,`TEST-scope-${n}`,request);t.h.tick();await t.h.drain();
   expect(t.h.get(user,task.id).status).toBe('completed');return t.calls.at(-1)!.body;
  };
  await submit(1);const resumed=await submit(2,{chapterNo:2});
  expect(JSON.stringify(resumed.messages)).toContain('TEST isolated record 1');
  const snapshots=t.deps.db.select().from(writingMemorySessions).all();expect(snapshots).toHaveLength(2);
  // A fresh harness instance must restore the DB log, independent of process memory.
  const h2=new WritingHarness(t.deps,async(_url,init)=>{t.calls.push({url:'TEST',headers:new Headers(),body:JSON.parse(String(init?.body))});return topicMaintenanceResponse(t.calls.at(-1)!.body) ?? new Response('data: {"choices":[{"index":0,"delta":{"content":"TEST restored"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');});live.push(h2);
  const task=await h2.create(owner.user.id,'TEST-scope-restored',{...body,topicTree:{...scope,chapterNo:2}});h2.tick();await h2.drain();
  expect(h2.get(owner.user.id,task.id).status).toBe('completed');expect(t.calls.some(c=>c.body.tools?.length && JSON.stringify(c.body.messages).includes('TEST isolated record 1'))).toBe(true);
  for(const [n,change,user] of [[3,{branchId:'TEST-alternate'},owner.user.id],[4,{epoch:'d'.repeat(64)},owner.user.id],[5,{channel:'consistency'},owner.user.id],[6,{},other.user.id],[7,{chapterNo:0},owner.user.id]] as const) {
   const input=await submit(n,change,user);expect(JSON.stringify(input.messages)).not.toContain('TEST isolated record 1');expect(JSON.stringify(input.messages)).not.toContain('TEST isolated record 2');
  }
  const a=await t.h.create(owner.user.id,'TEST-scope-queued-a',{...body,topicTree:{...scope,chapterNo:2}}),b=await t.h.create(owner.user.id,'TEST-scope-queued-b',{...body,topicTree:{...scope,chapterNo:2}});
  t.h.tick();expect(t.h.get(owner.user.id,a.id).status).toBe('running');expect(t.h.get(owner.user.id,b.id).status).toBe('queued');
  await t.h.drain();t.h.tick();await t.h.drain();expect(t.h.get(owner.user.id,b.id).status).toBe('completed');
 });
 test('changed same-chapter candidate cannot recall a previous candidate; failed authentication commits no memory',async()=>{
  const t=fixture();const o=await t.register('TEST-topic-version@example.com');
  const first=await t.h.create(o.user.id,'TEST-version-a',{...body,topicTree:scope});t.h.tick();await t.h.drain();expect(t.h.get(o.user.id,first.id).status).toBe('completed');
  const second=await t.h.create(o.user.id,'TEST-version-b',{...body,topicTree:scope,binding:{...body.binding,candidateVersionId:'TEST-other-version'}});t.h.tick();await t.h.drain();
  expect(t.calls.at(-1)!.body.messages.filter((m:any)=>m.role==='assistant')).toHaveLength(0);
  const failed=fixture({fetch:async()=>new Response('TEST vendor auth failure',{status:401})});const p=await failed.register('TEST-topic-auth@example.com');
  const bad=await failed.h.create(p.user.id,'TEST-topic-auth',{...body,topicTree:scope});failed.h.tick();await failed.h.drain();
  expect(failed.h.get(p.user.id,bad.id).error?.kind).toBe('auth');expect(failed.deps.db.select().from(writingMemorySessions).all()).toHaveLength(0);
  t.clock.advance(91*86400000);await t.h.gc();expect(t.deps.db.select().from(writingMemorySessions).all()).toHaveLength(0);
 });
});
