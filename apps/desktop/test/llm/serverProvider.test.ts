import { describe, expect, it } from 'vitest';
import { ServerProvider, type PendingStore } from '@/llm/serverProvider';
import { PublicApi } from '@/sync/api';
import { complete } from '@/llm/complete';
import { useTestDb } from '../helpers/testDb';
import { getSetting, loadAppSettings } from '@/db/repos/settingsRepo';
import { providerForPurpose } from '@/llm/registry';

// TEST SIMULATED backend. No real model result or writing-quality claim.
const caps = { enabled: true, engine: 'pi' as const, protocolVersion: 1 as const, provider: 'lunaroute', model: 'TEST-model',
  contextWindow: 1048576, maxOutputTokens: 262144, reasoningTokens: 32000, reasoningEffort: 'low' as const, jsonMode: 'json_schema' as const, retentionHours: 24 };
const task = { id: 'TEST-task', requestHash: 'a'.repeat(64), status: 'running', model: 'TEST-model', provider: 'lunaroute', createdAt: 0, expiresAt: 86400000, error: null, usage: null };
function memory() {
  const rows = new Map<string, any>();
  const store: PendingStore = { get: async key => rows.get(key) ?? null, set: async (key, value) => { rows.set(key, value); }, delete: async key => { rows.delete(key); } };
  return { rows, store };
}
const request = { messages: [{ role: 'user' as const, content: 'TEST input' }], maxTokens: 200 };

describe('ServerProvider (TEST SIMULATED)', () => {
  it('production defaults to a developer service and never silently falls back to local keys', async () => {
    useTestDb(undefined, 'server');
    expect((await loadAppSettings()).aiServiceMode).toBe('server');
    expect(await getSetting('aiServiceMode', '')).toBe('server');
    await expect(providerForPurpose('writing')).rejects.toMatchObject({ kind: 'auth' });
  });
  it('replays output through the common provider abstraction; sends only the session credential', async () => {
    const pending = memory(); const calls: { url: string; init?: RequestInit }[] = [];
    const api = new PublicApi('https://TEST.invalid', async () => 'TEST-login-token', '', async (url, init) => {
      calls.push({ url: String(url), init });
      if (init?.method === 'POST') return Response.json(task);
      return Response.json({ task: { ...task, status: 'completed', usage: { inputTokens: 11, outputTokens: 7 } }, events: [
        { seq: 1, event: { type: 'delta', text: 'TEST 中文' } },
        { seq: 2, event: { type: 'usage', inputTokens: 11, outputTokens: 7 } },
        { seq: 3, event: { type: 'done', finishReason: 'stop' } },
      ], hasMore: false });
    });
    const result = await complete(new ServerProvider(api, caps, 'TEST-user', pending.store, 0), request);
    expect(result).toEqual({ text: 'TEST 中文', usage: { inputTokens: 11, outputTokens: 7 }, finishReason: 'stop' });
    expect(new Headers(calls[0]!.init!.headers).get('Authorization')).toBe('Bearer TEST-login-token');
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual(request);
    expect(String(calls[0]!.init!.body)).not.toContain('apiKey'); expect(pending.rows.size).toBe(0);
  });
  it('uncertain POST acknowledgement reuses the durable key after reconstructing the provider', async () => {
    const pending = memory(); const keys: string[] = []; let posts = 0;
    const api = new PublicApi('https://TEST.invalid', async () => 'TEST-token', '', async (_url, init) => {
      if (init?.method === 'POST') {
        keys.push(new Headers(init.headers).get('Idempotency-Key')!);
        if (posts++ === 0) throw new TypeError('TEST connection lost after server accepted POST');
        return Response.json(task);
      }
      return Response.json({ task: { ...task, status: 'completed' }, events: [{ seq: 1, event: { type: 'done', finishReason: 'stop' } }], hasMore: false });
    });
    await expect(complete(new ServerProvider(api, caps, 'TEST-user', pending.store, 0), request)).rejects.toMatchObject({ kind: 'network' });
    expect(pending.rows.size).toBe(1);
    await complete(new ServerProvider(api, caps, 'TEST-user', pending.store, 0), request);
    expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]); expect(pending.rows.size).toBe(0);
  });
  it('a broken GET resumes the same task without another POST or duplicated text', async () => {
    const pending = memory(); let posts = 0, gets = 0;
    const api = new PublicApi('https://TEST.invalid', async () => 'TEST-token', '', async (_url, init) => {
      if (init?.method === 'POST') { posts++; return Response.json(task); }
      if (gets++ === 0) throw new TypeError('TEST disconnected');
      return Response.json({ task: { ...task, status: 'completed' }, events: [
        { seq: 1, event: { type: 'delta', text: 'TEST recovered' } }, { seq: 2, event: { type: 'done', finishReason: 'stop' } },
      ], hasMore: false });
    });
    await expect(complete(new ServerProvider(api, caps, 'TEST-user', pending.store, 0), request)).rejects.toMatchObject({ kind: 'network' });
    const result = await complete(new ServerProvider(api, caps, 'TEST-user', pending.store, 0), request);
    expect(posts).toBe(1); expect(result.text).toBe('TEST recovered');
  });
  it('rejects missing event blocks and mismatched version bindings', async () => {
    for (const page of [
      { task: { ...task, status: 'completed' }, events: [{ seq: 2, event: { type: 'done', finishReason: 'stop' } }], hasMore: false },
      { task: { ...task, status: 'completed', binding: { operationId: 'TEST-stale', candidateVersionId: null, contentHash: null, dependencyHash: null } }, events: [], hasMore: false },
    ]) {
      const api = new PublicApi('https://TEST.invalid', async () => 'TEST-token', '', async (_url, init) => Response.json(init?.method === 'POST' ? task : page));
      await expect(complete(new ServerProvider(api, caps, 'TEST-user', memory().store, 0), request)).rejects.toMatchObject({ kind: 'bad_request' });
    }
  });
  it('interrupted execution requires explicit retry rather than automatic upstream repetition', async () => {
    const pending = memory();
    const api = new PublicApi('https://TEST.invalid', async () => 'TEST-token', '', async (_url, init) => Response.json(init?.method === 'POST' ? task : {
      task: { ...task, status: 'interrupted', error: { kind: 'network', message: 'TEST upstream outcome unknown' } }, events: [], hasMore: false,
    }));
    await expect(complete(new ServerProvider(api, caps, 'TEST-user', pending.store, 0), request)).rejects.toMatchObject({ kind: 'bad_request', message: 'TEST upstream outcome unknown', retryable: false });
    expect(pending.rows.size).toBe(0);
  });
  it('cancellation sends DELETE and never emits a completion verdict', async () => {
    const pending = memory(), abort = new AbortController(); const methods: string[] = [];
    const api = new PublicApi('https://TEST.invalid', async () => 'TEST-token', '', async (_url, init) => {
      methods.push(init!.method!);
      if (init?.method === 'POST') return Response.json(task);
      if (init?.method === 'DELETE') return Response.json({ ...task, status: 'cancelled' });
      abort.abort();
      return Response.json({ task, events: [], hasMore: false });
    });
    await expect(complete(new ServerProvider(api, caps, 'TEST-user', pending.store, 0), { ...request, signal: abort.signal })).rejects.toMatchObject({ kind: 'aborted' });
    expect(methods).toEqual(['POST', 'GET', 'DELETE']); expect(pending.rows.size).toBe(0);
  });
  it('never resubmits an uncertain acknowledgement after the idempotency retention window', async () => {
    const pending = memory(); let posts = 0;
    const api = new PublicApi('https://TEST.invalid', async () => 'TEST-token', '', async () => { posts++; throw new TypeError('TEST lost acknowledgement'); });
    await expect(complete(new ServerProvider(api, caps, 'TEST-user', pending.store, 0), request)).rejects.toMatchObject({ kind: 'network' });
    for (const saved of pending.rows.values()) saved.createdAt = Date.now() - 25 * 3600000;
    await expect(complete(new ServerProvider(api, caps, 'TEST-user', pending.store, 0), request)).rejects.toMatchObject({ kind: 'bad_request', retryable: false });
    expect(posts).toBe(1); expect(pending.rows.size).toBe(0);
  });
  it('an expired login retains the remote task identity until the same owner signs in again', async () => {
    const pending = memory(); let posts = 0, reads = 0;
    const api = new PublicApi('https://TEST.invalid', async () => 'TEST-session', '', async (_url, init) => {
      if (init?.method === 'POST') { posts++; return Response.json(task); }
      if (reads++ === 0) return Response.json({ error: { code: 'UNAUTHORIZED', message: 'TEST expired session' } }, { status: 401 });
      return Response.json({ task: { ...task, status: 'completed' }, events: [{ seq: 1, event: { type: 'delta', text: 'TEST recovered after login' } }, { seq: 2, event: { type: 'done', finishReason: 'stop' } }], hasMore: false });
    });
    await expect(complete(new ServerProvider(api, caps, 'TEST-owner', pending.store, 0), request)).rejects.toMatchObject({ kind: 'auth' });
    expect(pending.rows.size).toBe(1);
    expect((await complete(new ServerProvider(api, caps, 'TEST-owner', pending.store, 0), request)).text).toBe('TEST recovered after login');
    expect(posts).toBe(1); expect(pending.rows.size).toBe(0);
  });
});

it('TEST forwards topic-tree scope and immutable binding through the desktop transport',async()=>{
 const pending=memory();let sent:any;
 const topicTree={workId:'TEST-fiction',branchId:'adopted',channel:'consistency',chapterNo:6,epoch:'a'.repeat(64)};
 const binding={operationId:'TEST-topic-review',candidateVersionId:'TEST-candidate',contentHash:'b'.repeat(64),dependencyHash:'c'.repeat(64)};
 const api=new PublicApi('https://TEST.invalid',async()=>'TEST-session-token','',async(_url,init)=>{
  if(init?.method==='POST'){sent=JSON.parse(String(init.body));return Response.json({...task,binding});}
  return Response.json({task:{...task,binding,status:'completed'},events:[{seq:1,event:{type:'delta',text:'TEST reviewed'}},{seq:2,event:{type:'done',finishReason:'stop'}}],hasMore:false});
 });
 const result=await complete(new ServerProvider(api,{...caps,topicTree:{enabled:true,version:'0.2.0',maxModelCalls:16,scopeRequired:true}},'TEST-owner',pending.store,0),{...request,topicTree,binding});
 expect(sent.topicTree).toEqual(topicTree);expect(sent.binding).toEqual(binding);expect(result.text).toBe('TEST reviewed');
});
