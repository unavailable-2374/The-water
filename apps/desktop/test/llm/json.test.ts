import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { appendSchemaInstruction, normalizeJsonText, parseJsonLoose, requestJson, schemaInstructionTokens, schemaReserveTokens, zodToJsonSchema } from '@/llm/json';
import { DEFAULT_JSON_REPAIR_ROUNDS } from '@/llm/config';
import { buildContextBudget } from '@/llm/prompts/context';
import { complete, completeWithRetry } from '@/llm/complete';
import { RateGate } from '@/llm/retry';
import { LLMError, type CompletionRequest, type LLMProvider, type ProviderCaps, type StreamEvent } from '@/llm/types';

describe('parseJsonLoose', () => {
  it('parses plain JSON', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('  [1,2] ')).toEqual([1, 2]);
  });

  it('strips markdown fences and surrounding prose', () => {
    expect(parseJsonLoose('好的，结果如下：\n```json\n{"a": 1}\n```\n希望有帮助。')).toEqual({ a: 1 });
    expect(parseJsonLoose('```\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('前言 {"a": {"b": [1]}} 后记')).toEqual({ a: { b: [1] } });
  });

  it('removes trailing commas', () => {
    expect(parseJsonLoose('{"a": [1, 2, ], "b": {"c": 1,},}')).toEqual({ a: [1, 2], b: { c: 1 } });
    expect(parseJsonLoose('[1,\n2,\n]')).toEqual([1, 2]);
  });

  it('normalises full-width punctuation outside strings but preserves it inside', () => {
    const text = '{“title”：“你好，世界：再见”， “n”： 1，}';
    expect(parseJsonLoose(text)).toEqual({ title: '你好，世界：再见', n: 1 });
    expect(parseJsonLoose('{"quote": "全角，逗号：冒号“引号”保留", "k": 2}')).toEqual({ quote: '全角，逗号：冒号“引号”保留', k: 2 });
    expect(parseJsonLoose('{‘a’：‘bc’}')).toEqual({ a: 'bc' });
    // ASCII quote inside a full-width-quoted string gets escaped rather than terminating it.
    expect(parseJsonLoose('{“a”：“say "hi" now”}')).toEqual({ a: 'say "hi" now' });
  });

  it('keeps escaped quotes and commas inside strings intact', () => {
    expect(normalizeJsonText('{"a": "x\\"y, }", "b": [1, ]}')).toBe('{"a": "x\\"y, }", "b": [1]}');
  });

  it('throws SyntaxError including the cleaned text', () => {
    let err: unknown;
    try {
      parseJsonLoose('```json\n{"a": tru}\n```');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SyntaxError);
    expect((err as Error).message).toContain('{"a": tru}');
  });
});

describe('zodToJsonSchema / appendSchemaInstruction', () => {
  it('strips $schema', () => {
    const s = zodToJsonSchema(z.object({ a: z.string() }));
    expect(s.$schema).toBeUndefined();
    expect(s).toMatchObject({ type: 'object', required: ['a'], additionalProperties: false });
  });

  it('appends to the last user message', () => {
    const out = appendSchemaInstruction(
      [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
      { type: 'object' },
    );
    expect(out[2]!.content).toBe('c\n\n只输出一个 JSON 对象，不要任何解释或 Markdown 代码块。JSON 必须符合以下 JSON Schema：\n{"type":"object"}');
    expect(out[0]!.content).toBe('a');
  });
});

// ---------------------------------------------------------------------------

interface Scripted {
  finishReason?:'length' | 'stop';
  text?: string;
  error?: LLMError;
  usage?: { inputTokens: number; outputTokens: number };
}

function scriptedProvider(script: Scripted[], caps: Partial<ProviderCaps> = {}) {
  const requests: CompletionRequest[] = [];
  let i = 0;
  const provider: LLMProvider = {
    id: 'scripted',
    model: 'm',
    kind: 'openai_compatible',
    caps: { contextWindow: 100000, maxOutputTokens: 4096, jsonMode: 'json_object', cjkTokenRatio: 0.7, ...caps },
    async *stream(req): AsyncIterable<StreamEvent> {
      requests.push(req);
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      if (step.error) throw step.error;
      const text = step.text ?? '';
      for (const part of text.match(/.{1,5}/gs) ?? []) yield { type: 'delta', text: part };
      const u = step.usage ?? { inputTokens: 10, outputTokens: 5 };
      yield { type: 'usage', inputTokens: u.inputTokens, outputTokens: u.outputTokens };
      yield { type: 'done', finishReason: step.finishReason ?? 'stop' };
    },
  };
  return { provider, requests };
}

const fastGate = () => new RateGate('t', { minIntervalMs: 0, sleep: async () => {} });

describe('complete', () => {
  it('collects text, reports deltas and merges usage', async () => {
    const { provider } = scriptedProvider([{ text: 'hello world', usage: { inputTokens: 3, outputTokens: 7 } }]);
    const seen: Array<[string, string]> = [];
    const r = await complete(provider, { messages: [], maxTokens: 10 }, (d, acc) => seen.push([d, acc]));
    expect(r).toEqual({ text: 'hello world', usage: { inputTokens: 3, outputTokens: 7 }, finishReason: 'stop' });
    expect(seen[0]).toEqual(['hello', 'hello']);
    expect(seen.at(-1)![1]).toBe('hello world');
  });

  it('completeWithRetry reports 429 to the gate and retries', async () => {
    const { provider, requests } = scriptedProvider([
      { error: new LLMError('rate_limit', '429', { status: 429, retryAfterMs: 1234 }) },
      { text: 'ok' },
    ]);
    const gate = fastGate();
    const r = await completeWithRetry(provider, { messages: [], maxTokens: 1 }, { gate, sleep: async () => {} });
    expect(r.text).toBe('ok');
    expect(requests).toHaveLength(2);
    expect(gate.cooldownUntil).toBeGreaterThan(0);
  });
});

describe('requestJson', () => {
  const schema = z.object({ title: z.string(), chapters: z.number().int() });
  const spec = { messages: [{ role: 'user' as const, content: '生成' }], maxTokens: 200, temperature: 0.7, schema, label: '测试' };

  it('returns the parsed value on first success and appends schema hint for json_object providers', async () => {
    const { provider, requests } = scriptedProvider([{ text: '```json\n{"title": "书", "chapters": 3,}\n```' }]);
    const r = await requestJson(provider, spec, { gate: fastGate() });
    expect(r.value).toEqual({ title: '书', chapters: 3 });
    expect(r.raw).toContain('"title"');
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.messages[0]!.content).toContain('只输出一个 JSON 对象');
    expect(req.messages[0]!.content).toContain('"chapters"');
    expect(req.json?.name).toBe('result');
    expect(req.json?.schema.$schema).toBeUndefined();
    expect(req.temperature).toBe(0.7);
  });

  it('does not append the schema hint for json_schema / tool providers', async () => {
    for (const jsonMode of ['json_schema', 'tool'] as const) {
      const { provider, requests } = scriptedProvider([{ text: '{"title":"a","chapters":1}' }], { jsonMode });
      await requestJson(provider, spec, { gate: fastGate() });
      expect(requests[0]!.messages[0]!.content).toBe('生成');
      expect(requests[0]!.json).toBeDefined();
    }
  });

  it('runs a repair round at temperature 0 and sums usage', async () => {
    const { provider, requests } = scriptedProvider([
      { text: '{"title": "书", "chapters": "三"}', usage: { inputTokens: 10, outputTokens: 5 } },
      { text: '{"title": "书", "chapters": 3}', usage: { inputTokens: 20, outputTokens: 6 } },
    ]);
    const onDelta = [] as string[];
    const r = await requestJson(provider, spec, { gate: fastGate(), onDelta: (d) => void onDelta.push(d) });
    expect(r.value).toEqual({ title: '书', chapters: 3 });
    expect(r.usage).toEqual({ inputTokens: 30, outputTokens: 11 });
    expect(requests).toHaveLength(2);
    const repair = requests[1]!;
    expect(repair.temperature).toBe(0);
    expect(repair.messages).toHaveLength(3);
    expect(repair.messages[1]).toEqual({ role: 'assistant', content: '{"title": "书", "chapters": "三"}' });
    expect(repair.messages[2]!.role).toBe('user');
    expect(repair.messages[2]!.content).toContain('上面的 JSON 无法通过校验，错误：chapters:');
    expect(repair.messages[2]!.content).toContain('请只输出修正后的完整 JSON，不要解释。');
    expect(onDelta.length).toBeGreaterThan(0);
  });

  it('throws LLMError bad_request with raw after every repair round fails', async () => {
    const { provider, requests } = scriptedProvider([{ text: 'not json at all' }, { text: '{"title": 1}' }]);
    const err = await requestJson(provider, spec, { gate: fastGate() }).catch((e) => e as LLMError);
    expect(err).toBeInstanceOf(LLMError);
    expect(err).toMatchObject({ kind: 'bad_request', raw: '{"title": 1}' });
    expect((err as LLMError).message).toContain('测试');
    // 默认 2 轮修复：首轮 + 2 次修复 = 3 次请求。
    expect(requests).toHaveLength(1 + DEFAULT_JSON_REPAIR_ROUNDS);
    expect((err as LLMError).message).toContain(`${1 + DEFAULT_JSON_REPAIR_ROUNDS} 次校验失败`);
    expect(requests[1]!.messages[2]!.content).toContain('JSON 语法错误');
  });

  it('repairRounds is configurable (0 = no repair)', async () => {
    const bad = [{ text: 'not json at all' }];
    const noRepair = scriptedProvider(bad);
    await expect(requestJson(noRepair.provider, spec, { gate: fastGate(), repairRounds: 0 })).rejects.toMatchObject({ kind: 'bad_request' });
    expect(noRepair.requests).toHaveLength(1);

    const three = scriptedProvider(bad);
    await expect(requestJson(three.provider, spec, { gate: fastGate(), repairRounds: 3 })).rejects.toMatchObject({ kind: 'bad_request' });
    expect(three.requests).toHaveLength(4);
  });

  it('counts the injected schema against the context budget only in json_object / none mode', async () => {
    const jsonSchema = zodToJsonSchema(schema);
    const injected = schemaInstructionTokens(jsonSchema, { jsonMode: 'json_object', cjkTokenRatio: 0.7 });
    expect(injected).toBeGreaterThan(0);
    expect(schemaInstructionTokens(jsonSchema, { jsonMode: 'json_schema', cjkTokenRatio: 0.7 })).toBe(0);
    expect(schemaInstructionTokens(jsonSchema, { jsonMode: 'tool', cjkTokenRatio: 0.7 })).toBe(0);
    expect(schemaReserveTokens(schema, { jsonMode: 'none', cjkTokenRatio: 0.7 })).toBe(injected);

    const caps = { contextWindow: 128_000, maxOutputTokens: 8192, jsonMode: 'json_object' as const, cjkTokenRatio: 0.7 };
    const plain = buildContextBudget({ caps, maxTokens: 4000 });
    expect(buildContextBudget({ caps, maxTokens: 4000, reserved: injected })).toBe(plain - injected);
  });

  it('propagates transport errors without a repair round', async () => {
    const { provider, requests } = scriptedProvider([{ error: new LLMError('auth', 'nope') }]);
    await expect(requestJson(provider, spec, { gate: fastGate() })).rejects.toMatchObject({ kind: 'auth' });
    expect(requests).toHaveLength(1);
  });

  it('retry: false bypasses gate and retry', async () => {
    const { provider, requests } = scriptedProvider([{ error: new LLMError('server', '500') }]);
    await expect(requestJson(provider, spec, { retry: false })).rejects.toMatchObject({ kind: 'server' });
    expect(requests).toHaveLength(1);
  });
});


describe('TEST truncated structured output',()=>{
 it('TEST stops escalating after two empty budget-exhausted responses and preserves real reported usage',async()=>{
  const {provider,requests}=scriptedProvider([{text:'',finishReason:'length',usage:{inputTokens:10,outputTokens:38000}},{text:'',finishReason:'length',usage:{inputTokens:10,outputTokens:70000}},{text:'{"ok":true}'}],{reasoningTokens:32000,maxOutputTokens:262144,contextWindow:1048576});
  await expect(requestJson(provider,{messages:[],maxTokens:6000,schema:z.object({ok:z.boolean()}),label:'TEST empty output'},{retry:false})).rejects.toMatchObject({usage:{inputTokens:20,outputTokens:108000},message:expect.stringContaining('模型连续两次耗尽预算')});
  expect(requests).toHaveLength(2);
 });
 it('reports actual validation attempts when the configured output cap stops retries',async()=>{
  const {provider,requests}=scriptedProvider([{text:'',finishReason:'length'},{text:'',finishReason:'length'}],{maxOutputTokens:200});
  await expect(requestJson(provider,{messages:[],maxTokens:100,schema:z.object({ok:z.boolean()}),label:'TEST cap'},{retry:false})).rejects.toThrow('JSON 2 次校验失败');
  expect(requests).toHaveLength(2);
 });
 it('uses the same reasoning-aware budget growth as prose',async()=>{
  const {provider,requests}=scriptedProvider([{text:'',finishReason:'length'},{text:'{"ok":true}'}],{reasoningTokens:32000,maxOutputTokens:65536,contextWindow:1048576});
  const result=await requestJson(provider,{messages:[],maxTokens:2500,schema:z.object({ok:z.boolean()}),label:'TEST reasoning'},{retry:false});
  expect(requests.map(r=>r.maxTokens)).toEqual([2500,33536]);expect(result.value.ok).toBe(true);
 });
 it('increases output budget instead of repairing an absent JSON document',async()=>{
  const {provider,requests}=scriptedProvider([{text:'',finishReason:'length',usage:{inputTokens:10,outputTokens:100}},{text:'{"ok":true}'}]);
  const result=await requestJson(provider,{messages:[{role:'user',content:'TEST JSON'}],maxTokens:100,temperature:0.6,schema:z.object({ok:z.boolean()}),label:'TEST'},{retry:false});
  expect(requests.map(r=>r.maxTokens)).toEqual([100,200]);expect(result.value).toEqual({ok:true});expect(result.usage.outputTokens).toBe(105);
  expect(requests.map(r=>r.temperature)).toEqual([0.6,0.6]);
 });
 it('never accepts a truncated result even if its prefix parses',async()=>{
  const {provider}=scriptedProvider([{text:'{"ok":true}',finishReason:'length'}],{maxOutputTokens:100});
  await expect(requestJson(provider,{messages:[],maxTokens:100,schema:z.object({ok:z.boolean()}),label:'TEST'},{retry:false})).rejects.toThrow('输出预算耗尽');
 });
});

// TEST transport failure accounting; reported usage is retained, never estimated.
it('TEST retains reported tokens across a failed streamed attempt and retry',async()=>{
 let calls=0;
 const {provider}=scriptedProvider([]);
 provider.stream=async function*(){calls++;yield {type:'usage',inputTokens:7,outputTokens:4};if(calls===1) throw new LLMError('network','TEST disconnect');yield {type:'delta',text:'TEST result'};yield {type:'done',finishReason:'stop'};};
 const result=await completeWithRetry(provider,{messages:[],maxTokens:100},{gate:fastGate(),sleep:async()=>{}});
 expect(result.usage).toEqual({inputTokens:14,outputTokens:8});expect(calls).toBe(2);
});
it('TEST truncated prose cannot become a successful text response',async()=>{
 const {provider}=scriptedProvider([{text:'TEST partial',finishReason:'length',usage:{inputTokens:9,outputTokens:20}}],{maxOutputTokens:20});
 await expect(completeWithRetry(provider,{messages:[],maxTokens:20},{gate:fastGate(),requireComplete:true})).rejects.toMatchObject({kind:'bad_request',usage:{inputTokens:9,outputTokens:20}});
});
it('TEST empty prose exhaustion stops after one larger-budget retry without inventing text',async()=>{
 const {provider,requests}=scriptedProvider([{text:'',finishReason:'length',usage:{inputTokens:9,outputTokens:100}}],{maxOutputTokens:1000});
 await expect(completeWithRetry(provider,{messages:[],maxTokens:100},{gate:fastGate(),requireComplete:true})).rejects.toMatchObject({kind:'bad_request',usage:{inputTokens:18,outputTokens:200},message:expect.stringContaining('未返回正文')});
 expect(requests).toHaveLength(2);
});
it('TEST prose output exhaustion retries within the configured reasoning/window cap and accounts for both calls',async()=>{
 const {provider,requests}=scriptedProvider([{text:'TEST partial',finishReason:'length',usage:{inputTokens:9,outputTokens:100}},{text:'TEST complete',usage:{inputTokens:9,outputTokens:50}}],{reasoningTokens:80,maxOutputTokens:200});
 const result=await completeWithRetry(provider,{messages:[],maxTokens:20},{gate:fastGate(),requireComplete:true});
 expect(requests.map(r=>r.maxTokens)).toEqual([20,100]);expect(result.text).toBe('TEST complete');expect(result.usage).toEqual({inputTokens:18,outputTokens:150});
});
