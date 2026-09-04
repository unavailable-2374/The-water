import { describe, expect, it } from 'vitest';
import { AnthropicProvider, normalizeAnthropicMessages, resolveMessagesUrl } from '@/llm/anthropic';
import { LLMError } from '@/llm/types';
import { collect, fakeFetch, makeConfig, sseBody, sseResponse } from './helpers';

const cfg = (over = {}) =>
  makeConfig({ id: 'anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', jsonMode: 'tool', contextWindow: 200000, maxOutputTokens: 16000, ...over });

const ev = (type: string, data: Record<string, unknown>) => ({ event: type, data: { type, ...data } });

function textStream(stopReason = 'end_turn') {
  return sseResponse([
    sseBody([
      ev('message_start', { message: { id: 'm', role: 'assistant', content: [], usage: { input_tokens: 25, output_tokens: 1 } } }),
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ev('ping', {}),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '第一' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '章' } }),
      ev('content_block_stop', { index: 0 }),
      ev('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 15 } }),
      ev('message_stop', {}),
    ]),
  ]);
}

describe('resolveMessagesUrl', () => {
  it('normalises base urls', () => {
    expect(resolveMessagesUrl('')).toBe('https://api.anthropic.com/v1/messages');
    expect(resolveMessagesUrl('https://api.anthropic.com/')).toBe('https://api.anthropic.com/v1/messages');
    expect(resolveMessagesUrl('https://proxy.example.com/v1')).toBe('https://proxy.example.com/v1/messages');
    expect(resolveMessagesUrl('https://proxy.example.com/v1/messages')).toBe('https://proxy.example.com/v1/messages');
  });
});

describe('normalizeAnthropicMessages', () => {
  it('hoists system messages, merges consecutive roles, ensures first is user', () => {
    const r = normalizeAnthropicMessages([
      { role: 'system', content: 'S1' },
      { role: 'user', content: 'u1' },
      { role: 'system', content: 'S2' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a1' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ]);
    expect(r.system).toBe('S1\n\nS2');
    expect(r.messages).toEqual([
      { role: 'user', content: 'u1\n\nu2' },
      { role: 'assistant', content: 'a1\n\na2' },
      { role: 'user', content: 'u3' },
    ]);

    const r2 = normalizeAnthropicMessages([{ role: 'assistant', content: 'a' }]);
    expect(r2.system).toBeUndefined();
    expect(r2.messages[0]!.role).toBe('user');
    expect(r2.messages[1]).toEqual({ role: 'assistant', content: 'a' });

    expect(normalizeAnthropicMessages([]).messages).toHaveLength(1);
  });
});

describe('AnthropicProvider', () => {
  it('sends the right request shape and streams text', async () => {
    const { fetch, calls } = fakeFetch([textStream()]);
    const p = new AnthropicProvider(cfg({ extraHeaders: { 'anthropic-beta': 'x' } }), 'sk-ant', fetch);
    expect(p.caps.cjkTokenRatio).toBe(1.0);
    const events = await collect(
      p.stream({
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hi' },
        ],
        maxTokens: 500,
        temperature: 0.3,
        stop: ['###'],
      }),
    );
    expect(events).toEqual([
      { type: 'usage', inputTokens: 25, outputTokens: 1 },
      { type: 'delta', text: '第一' },
      { type: 'delta', text: '章' },
      { type: 'usage', inputTokens: 25, outputTokens: 15 },
      { type: 'done', finishReason: 'stop' },
    ]);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.headers['x-api-key']).toBe('sk-ant');
    expect(call.headers['anthropic-version']).toBe('2023-06-01');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.headers['anthropic-beta']).toBe('x');
    expect(call.body).toEqual({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.3,
      stop_sequences: ['###'],
      stream: true,
    });
  });

  it('json mode: forced emit_result tool, accumulates input_json_delta, ignores stray text', async () => {
    const { fetch, calls } = fakeFetch([
      sseResponse([
        sseBody([
          ev('message_start', { message: { usage: { input_tokens: 40, output_tokens: 2 } } }),
          ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
          ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Let me think.' } }),
          ev('content_block_stop', { index: 0 }),
          ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 't', name: 'emit_result', input: {} } }),
          ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"title":' } }),
          ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"x"}' } }),
          ev('content_block_stop', { index: 1 }),
          ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } }),
          ev('message_stop', {}),
        ]),
      ]),
    ]);
    const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false };
    const p = new AnthropicProvider(cfg(), 'k', fetch);
    const events = await collect(p.stream({ messages: [{ role: 'user', content: 'go' }], maxTokens: 100, json: { name: 'result', schema } }));
    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')).toBe('{"title":"x"}');
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool' });
    expect(calls[0]!.body.tools).toEqual([{ name: 'emit_result', description: '输出结构化结果', input_schema: schema }]);
    expect(calls[0]!.body.tool_choice).toEqual({ type: 'tool', name: 'emit_result' });
  });

  it('maps message_delta stop reasons', async () => {
    const { fetch } = fakeFetch([textStream('max_tokens'), textStream('stop_sequence'), textStream('refusal')]);
    const p = new AnthropicProvider(cfg(), 'k', fetch);
    const req = { messages: [{ role: 'user' as const, content: 'x' }], maxTokens: 10 };
    expect((await collect(p.stream(req))).at(-1)).toEqual({ type: 'done', finishReason: 'length' });
    expect((await collect(p.stream(req))).at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
    expect((await collect(p.stream(req))).at(-1)).toEqual({ type: 'done', finishReason: 'other' });
  });

  it('emits done exactly once even without message_stop', async () => {
    const { fetch } = fakeFetch([
      sseResponse([sseBody([ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'a' } })])]),
    ]);
    const p = new AnthropicProvider(cfg(), 'k', fetch);
    const events = await collect(p.stream({ messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }));
    expect(events).toEqual([
      { type: 'delta', text: 'a' },
      { type: 'done', finishReason: 'other' },
    ]);
  });

  it('turns in-stream error events into typed LLMErrors', async () => {
    const mk = (type: string, message: string) =>
      sseResponse([
        sseBody([
          ev('message_start', { message: { usage: { input_tokens: 1, output_tokens: 0 } } }),
          ev('error', { error: { type, message } }),
        ]),
      ]);
    const { fetch } = fakeFetch([
      mk('overloaded_error', 'Overloaded'),
      mk('rate_limit_error', 'slow'),
      mk('authentication_error', 'bad key'),
      mk('invalid_request_error', 'prompt is too long: 250000 tokens > 200000 maximum'),
      mk('invalid_request_error', 'messages: roles must alternate'),
    ]);
    const p = new AnthropicProvider(cfg(), 'k', fetch);
    const run = () => collect(p.stream({ messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }));
    await expect(run()).rejects.toMatchObject({ kind: 'server', message: 'Overloaded' });
    await expect(run()).rejects.toMatchObject({ kind: 'rate_limit' });
    await expect(run()).rejects.toMatchObject({ kind: 'auth' });
    await expect(run()).rejects.toMatchObject({ kind: 'context_length' });
    await expect(run()).rejects.toMatchObject({ kind: 'bad_request' });
  });

  it('maps HTTP errors (Anthropic body shape) and 529 overloaded', async () => {
    const { fetch } = fakeFetch([
      new Response('{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}', { status: 429, headers: { 'retry-after': '2' } }),
      new Response('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', { status: 529 }),
      new Response('{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}', { status: 400 }),
    ]);
    const p = new AnthropicProvider(cfg(), 'k', fetch);
    const run = () => collect(p.stream({ messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }));
    const e = await run().catch((x) => x as LLMError);
    expect(e).toMatchObject({ kind: 'rate_limit', retryAfterMs: 2000 });
    await expect(run()).rejects.toMatchObject({ kind: 'server', status: 529 });
    await expect(run()).rejects.toMatchObject({ kind: 'context_length' });
  });
});
