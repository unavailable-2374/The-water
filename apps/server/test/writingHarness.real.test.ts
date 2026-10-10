import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { HarnessPageSchema } from '@the-water/shared';
import { makeTestApp } from './helpers';
import { loadEnv } from '../src/env';
import { WritingHarness } from '../src/modules/writing/harness';

const real = process.env.WRITING_REAL_TEST === '1';
test.skipIf(!real)('REAL Lunaroute through authenticated Pi backend (TEST input; not quality evidence)', async () => {
  const env = loadEnv();
  if (!env.lunarouteApiKey) throw new Error('Developer backend LUNAROUTE_API_KEY is missing');
  const t = makeTestApp({ env: { ...env, writingHarnessEnabled: true, writingHarnessStorage: ':memory:', logFormat: 'off', errorReporting: 'off' } });
  const h = new WritingHarness(t.deps); t.deps.writingHarness = h;
  const startedAt = new Date().toISOString();
  try {
    const owner = await t.register(`TEST-harness-${Bun.randomUUIDv7()}@example.com`, 'TEST harness');
    const body = { messages: [{ role: 'user', content: 'TEST 后端接口验收，不是写作质量评测。请只回复：后端服务已连接。' }], maxTokens: 512, temperature: 0.6 };
    const created = await t.json('POST', '/api/v1/writing/tasks', { token: owner.token, body, headers: { 'Idempotency-Key': `TEST-real-${Bun.randomUUIDv7()}` } });
    expect(created.status).toBe(202); h.tick(); await h.drain();
    const response = await t.json('GET', `/api/v1/writing/tasks/${created.body.id}`, { token: owner.token });
    const page = HarnessPageSchema.parse(response.body);
    const record = { label: 'REAL provider response to TEST input; interface smoke only, not literary quality',
      startedAt, endedAt: new Date().toISOString(), engine: 'Pi', provider: page.task.provider, model: page.task.model,
      status: page.task.status, input: body, output: page.events.filter(e => e.event.type === 'delta').map(e => e.event.type === 'delta' ? e.event.text : '').join(''),
      finishReason: page.events.find(e => e.event.type === 'done')?.event, reportedUsage: page.task.usage, error: page.task.error,
      upstreamKeyInResponse: JSON.stringify(response.body).includes(env.lunarouteApiKey),
      verification: 'TEST account/email verification fixture; real upstream fetch, real Pi Agent loop, real Hono auth and task endpoints' };
    const output = process.env.WRITING_REAL_RECORD;
    if (output) { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(record, null, 2) + '\n'); }
    expect(page.task.status).toBe('completed');
    expect(page.events.find(e => e.event.type === 'done')?.event).toEqual({ type: 'done', finishReason: 'stop' });
    expect(record.output).toContain('后端服务已连接'); expect(record.upstreamKeyInResponse).toBe(false);
    // Writing reviews use structured JSON; chat-only success is insufficient for this transport.
    const structured = { messages: [{ role: 'user', content: 'TEST 结构化接口验收。只返回 JSON：testLabel 为 TEST，valid 为 true。' }], maxTokens: 512, temperature: 0.6,
      json: { name: 'TEST_harness_json', schema: { type: 'object', properties: { testLabel: { type: 'string', const: 'TEST' }, valid: { type: 'boolean' } }, required: ['testLabel', 'valid'], additionalProperties: false } } };
    const jsonTask = await t.json('POST', '/api/v1/writing/tasks', { token: owner.token, body: structured, headers: { 'Idempotency-Key': `TEST-json-${Bun.randomUUIDv7()}` } });
    expect(jsonTask.status).toBe(202); h.tick(); await h.drain();
    const jsonPage = HarnessPageSchema.parse((await t.json('GET', `/api/v1/writing/tasks/${jsonTask.body.id}`, { token: owner.token })).body);
    const jsonText = jsonPage.events.filter(e => e.event.type === 'delta').map(e => e.event.type === 'delta' ? e.event.text : '').join('');
    const structuredRecord = { label: 'REAL provider response to TEST structured input; not writing quality', endedAt: new Date().toISOString(),
      engine: 'Pi', provider: jsonPage.task.provider, model: jsonPage.task.model, input: structured, output: jsonText,
      status: jsonPage.task.status, reportedUsage: jsonPage.task.usage, error: jsonPage.task.error,
      finishReason: jsonPage.events.find(e => e.event.type === 'done')?.event };
    const jsonOutput = process.env.WRITING_REAL_JSON_RECORD;
    if (jsonOutput) { mkdirSync(dirname(jsonOutput), { recursive: true }); writeFileSync(jsonOutput, JSON.stringify(structuredRecord, null, 2) + '\n'); }
    expect(jsonPage.task.status).toBe('completed');
    expect(jsonPage.events.find(e => e.event.type === 'done')?.event).toEqual({ type: 'done', finishReason: 'stop' });
    expect(JSON.parse(jsonText)).toEqual({ testLabel: 'TEST', valid: true });
  } finally { await h.close(); }
}, 600000);
