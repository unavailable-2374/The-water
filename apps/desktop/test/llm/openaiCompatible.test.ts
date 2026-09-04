import { describe, expect, it } from 'vitest';
import { OpenAICompatibleProvider, isStrictJsonSchema, resolveChatCompletionsUrl } from '@/llm/openaiCompatible';
import { LLMError } from '@/llm/types';
import { collect, fakeFetch, makeConfig, sseBody, sseResponse } from './helpers';

function chunk(content: string | null, finish: string | null = null) {
  return { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }] };
}

const okStream = () =>
  sseResponse([
    sseBody([
      { data: { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] } },
      { data: chunk('你好') },
      { data: { choices: [{ index: 0, delta: { reasoning_content: 'thinking...' }, finish_reason: null }] } },
      { data: chunk('，世界') },
      { data: chunk(null, 'stop') },
      { data: { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } } },
      { data: '[DONE]' },
    ]),
  ]);

describe('resolveChatCompletionsUrl', () => {
  it('appends the suffix once', () => {
    expect(resolveChatCompletionsUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com/chat/completions');
    expect(resolveChatCompletionsUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/chat/completions');
    expect(resolveChatCompletionsUrl('https://x.com/v1/chat/completions/')).toBe('https://x.com/v1/chat/completions');
  });
});

describe('isStrictJsonSchema', () => {
  it('accepts fully-required closed objects and rejects optional props', () => {
    expect(isStrictJsonSchema({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false })).toBe(true);
    expect(isStrictJsonSchema({ type: 'object', properties: { a: { type: 'string' } }, required: [], additionalProperties: false })).toBe(false);
    expect(isStrictJsonSchema({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] })).toBe(false);
    expect(
      isStrictJsonSchema({
        type: 'object',
        properties: { list: { type: 'array', items: { type: 'object', properties: { b: {} }, required: [], additionalProperties: false } } },
        required: ['list'],
        additionalProperties: false,
      }),
    ).toBe(false);
  });
});

describe('OpenAICompatibleProvider', () => {
  it('streams deltas, ignores reasoning_content, emits usage then a single done', async () => {
    const { fetch, calls } = fakeFetch([okStream()]);
    const p = new OpenAICompatibleProvider(makeConfig({ extraHeaders: { 'X-Custom': '1' } }), 'sk-test', fetch);
    const events = await collect(p.stream({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }));
    expect(events).toEqual([
      { type: 'delta', text: '你好' },
      { type: 'delta', text: '，世界' },
      { type: 'usage', inputTokens: 12, outputTokens: 5 },
      { type: 'done', finishReason: 'stop' },
    ]);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);

    const call = calls[0]!;
    expect(call.url).toBe('https://api.example.com/v1/chat/completions');
    expect(call.init?.method).toBe('POST');
    expect(call.headers.Authorization).toBe('Bearer sk-test');
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.headers['X-Custom']).toBe('1');
    expect(call.body).toMatchObject({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      temperature: 0.8,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(call.body.stop).toBeUndefined();
    expect(call.body.response_format).toBeUndefined();
  });

  it('passes request temperature and stop, maps finish reasons', async () => {
    const { fetch, calls } = fakeFetch([
      sseResponse([sseBody([{ data: chunk('x', 'length') }, { data: '[DONE]' }])]),
      sseResponse([sseBody([{ data: chunk(null, 'tool_calls') }, { data: '[DONE]' }])]),
      sseResponse([sseBody([{ data: chunk(null, 'content_filter') }])]),
    ]);
    const p = new OpenAICompatibleProvider(makeConfig(), 'k', fetch);
    const e1 = await collect(p.stream({ messages: [], maxTokens: 1, temperature: 0, stop: ['END'] }));
    expect(e1.at(-1)).toEqual({ type: 'done', finishReason: 'length' });
    expect(calls[0]!.body.temperature).toBe(0);
    expect(calls[0]!.body.stop).toEqual(['END']);
    const e2 = await collect(p.stream({ messages: [], maxTokens: 1 }));
    expect(e2.at(-1)).toEqual({ type: 'done', finishReason: 'tool' });
    const e3 = await collect(p.stream({ messages: [], maxTokens: 1 }));
    expect(e3).toEqual([{ type: 'done', finishReason: 'other' }]);
  });

  it('sets response_format according to jsonMode', async () => {
    const strictSchema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
    const looseSchema = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
    const req = (schema: Record<string, unknown>) => ({ messages: [], maxTokens: 1, json: { name: 'result', schema } });

    const s1 = fakeFetch([okStream]);
    await collect(new OpenAICompatibleProvider(makeConfig({ jsonMode: 'json_schema' }), 'k', s1.fetch).stream(req(strictSchema)));
    expect(s1.calls[0]!.body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'result', schema: strictSchema, strict: true },
    });

    const s2 = fakeFetch([okStream]);
    await collect(new OpenAICompatibleProvider(makeConfig({ jsonMode: 'json_schema' }), 'k', s2.fetch).stream(req(looseSchema)));
    expect(s2.calls[0]!.body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'result', schema: looseSchema } });

    const s3 = fakeFetch([okStream]);
    await collect(new OpenAICompatibleProvider(makeConfig({ jsonMode: 'json_object' }), 'k', s3.fetch).stream(req(strictSchema)));
    expect(s3.calls[0]!.body.response_format).toEqual({ type: 'json_object' });

    for (const mode of ['none', 'tool'] as const) {
      const s = fakeFetch([okStream]);
      await collect(new OpenAICompatibleProvider(makeConfig({ jsonMode: mode }), 'k', s.fetch).stream(req(strictSchema)));
      expect(s.calls[0]!.body.response_format).toBeUndefined();
    }
  });

  it('maps HTTP errors: 429 → rate_limit w/ retryAfterMs, 400 context → context_length, 401 → auth', async () => {
    const mk = (status: number, body: string, headers: Record<string, string> = {}) =>
      new Response(body, { status, headers });
    const { fetch } = fakeFetch([
      mk(429, '{"error":{"message":"Rate limit reached"}}', { 'retry-after': '7' }),
      mk(400, '{"error":{"message":"This model\'s maximum context length is 8192 tokens.","code":"context_length_exceeded"}}'),
      mk(401, '{"error":{"message":"Incorrect API key"}}'),
      mk(400, '{"error":{"message":"unknown field"}}'),
      mk(503, 'upstream unavailable'),
    ]);
    const p = new OpenAICompatibleProvider(makeConfig(), 'k', fetch);
    const run = () => collect(p.stream({ messages: [], maxTokens: 1 }));

    const e1 = await run().catch((e) => e as LLMError);
    expect(e1).toBeInstanceOf(LLMError);
    expect(e1).toMatchObject({ kind: 'rate_limit', status: 429, retryAfterMs: 7000 });
    expect((e1 as LLMError).message).toContain('Rate limit reached');

    await expect(run()).rejects.toMatchObject({ kind: 'context_length', status: 400 });
    await expect(run()).rejects.toMatchObject({ kind: 'auth', status: 401 });
    await expect(run()).rejects.toMatchObject({ kind: 'bad_request', status: 400 });
    await expect(run()).rejects.toMatchObject({ kind: 'server', status: 503, raw: 'upstream unavailable' });
  });

  it('maps network failures and aborts', async () => {
    const net = fakeFetch([new TypeError('fetch failed')]);
    await expect(
      collect(new OpenAICompatibleProvider(makeConfig(), 'k', net.fetch).stream({ messages: [], maxTokens: 1 })),
    ).rejects.toMatchObject({ kind: 'network' });

    const ac = new AbortController();
    const abortFetch = fakeFetch([
      () => {
        ac.abort();
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    ]);
    await expect(
      collect(new OpenAICompatibleProvider(makeConfig(), 'k', abortFetch.fetch).stream({ messages: [], maxTokens: 1, signal: ac.signal })),
    ).rejects.toMatchObject({ kind: 'aborted' });
    // 传给 fetch 的是内部计时器的 signal（超时也要能中止），它跟随外部 signal 一起 abort。
    const passed = abortFetch.calls[0]!.init?.signal as AbortSignal;
    expect(passed).not.toBe(ac.signal);
    expect(passed.aborted).toBe(true);
  });

  it('aborts mid-stream → aborted', async () => {
    const ac = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseBody([{ data: chunk('part') }])));
      },
      pull() {
        return new Promise<void>((_, reject) => {
          ac.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      },
    });
    const { fetch } = fakeFetch([new Response(body, { status: 200 })]);
    const p = new OpenAICompatibleProvider(makeConfig(), 'k', fetch);
    const events: unknown[] = [];
    const run = async () => {
      for await (const ev of p.stream({ messages: [], maxTokens: 1, signal: ac.signal })) {
        events.push(ev);
        if (events.length === 1) ac.abort();
      }
    };
    await expect(run()).rejects.toMatchObject({ kind: 'aborted' });
    expect(events).toEqual([{ type: 'delta', text: 'part' }]);
  });

  it('surfaces in-stream error payloads as LLMError', async () => {
    const { fetch } = fakeFetch([sseResponse([sseBody([{ data: { error: { message: 'internal', type: 'server_error' } } }])])]);
    const p = new OpenAICompatibleProvider(makeConfig(), 'k', fetch);
    await expect(collect(p.stream({ messages: [], maxTokens: 1 }))).rejects.toMatchObject({ kind: 'server', message: 'internal' });
  });
});
