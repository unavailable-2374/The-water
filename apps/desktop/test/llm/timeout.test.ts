import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '@/llm/anthropic';
import { OpenAICompatibleProvider } from '@/llm/openaiCompatible';
import { completeWithRetry } from '@/llm/complete';
import { RateGate } from '@/llm/retry';
import { fetchWithTimeout, isTimeoutError, resolveTimeouts } from '@/llm/timeout';
import { DEFAULT_FIRST_BYTE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS } from '@/llm/config';
import { LLMError, type FetchLike } from '@/llm/types';
import { collect, fakeFetch, makeConfig, sseBody } from './helpers';

// 超时值刻意设得很小，测试里不做真实的几十秒等待。
const FAST = { firstByteTimeoutMs: 20, idleTimeoutMs: 20 };

const enc = new TextEncoder();

/** 建立连接后一个字节都不发的响应体（模拟供应商挂死）。 */
function silentBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => undefined); // 永不 resolve
    },
  });
}

/** 先发若干块、之后静默的响应体。 */
function stallAfter(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]!));
        return;
      }
      return new Promise<void>(() => undefined);
    },
  });
}

function sseResponseFrom(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const openaiChunk = (text: string) => sseBody([{ data: { choices: [{ delta: { content: text } }] } }]);
const anthropicChunk = (text: string) =>
  sseBody([{ event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }]);

describe('resolveTimeouts', () => {
  it('falls back to the defaults when the provider has no / invalid values', () => {
    expect(resolveTimeouts({})).toEqual({ firstByteMs: DEFAULT_FIRST_BYTE_TIMEOUT_MS, idleMs: DEFAULT_IDLE_TIMEOUT_MS });
    expect(resolveTimeouts({ firstByteTimeoutMs: 0, idleTimeoutMs: -1 })).toEqual({
      firstByteMs: DEFAULT_FIRST_BYTE_TIMEOUT_MS,
      idleMs: DEFAULT_IDLE_TIMEOUT_MS,
    });
    expect(resolveTimeouts({ firstByteTimeoutMs: 1000, idleTimeoutMs: 2000 })).toEqual({ firstByteMs: 1000, idleMs: 2000 });
  });

  it('providers read the timeouts off their config', () => {
    const p = new OpenAICompatibleProvider(makeConfig(FAST), 'k', fakeFetch([]).fetch);
    expect(p.timeouts).toEqual({ firstByteMs: 20, idleMs: 20 });
  });
});

describe('首字节超时', () => {
  it('连接建立后不发数据 → 可重试的 network 错误，而不是永久挂起', async () => {
    const f = fakeFetch([() => sseResponseFrom(silentBody())]);
    const provider = new OpenAICompatibleProvider(makeConfig(FAST), 'k', f.fetch);
    const err = await collect(provider.stream({ messages: [], maxTokens: 8 })).catch((e) => e as LLMError);
    expect(err).toBeInstanceOf(LLMError);
    expect((err as LLMError).kind).toBe('network');
    expect((err as LLMError).retryable).toBe(true);
    expect(isTimeoutError(err)).toBe(true);
    expect((err as LLMError).raw).toBe('timeout:first_byte');
  });

  it('真正 abort 了底层请求，而不是只 reject', async () => {
    const f = fakeFetch([() => sseResponseFrom(silentBody())]);
    const provider = new OpenAICompatibleProvider(makeConfig(FAST), 'k', f.fetch);
    await collect(provider.stream({ messages: [], maxTokens: 8 })).catch(() => undefined);
    expect((f.calls[0]!.init?.signal as AbortSignal).aborted).toBe(true);
  });

  it('fetch 本身永不 resolve 也会超时', async () => {
    const hang: FetchLike = () => new Promise<Response>(() => undefined);
    const provider = new OpenAICompatibleProvider(makeConfig(FAST), 'k', hang);
    await expect(collect(provider.stream({ messages: [], maxTokens: 8 }))).rejects.toMatchObject({
      kind: 'network',
      raw: 'timeout:first_byte',
    });
  });

  it('Anthropic 同样有首字节超时', async () => {
    const f = fakeFetch([() => sseResponseFrom(silentBody())]);
    const provider = new AnthropicProvider(makeConfig({ ...FAST, kind: 'anthropic' }), 'k', f.fetch);
    await expect(collect(provider.stream({ messages: [], maxTokens: 8 }))).rejects.toMatchObject({
      kind: 'network',
      raw: 'timeout:first_byte',
    });
  });
});

describe('流空闲超时', () => {
  it('发了几个块之后静默 → 可重试的 network 错误，已收到的 delta 照常抛出', async () => {
    const f = fakeFetch([() => sseResponseFrom(stallAfter([openaiChunk('第一'), openaiChunk('第二')]))]);
    const provider = new OpenAICompatibleProvider(makeConfig(FAST), 'k', f.fetch);
    const seen: string[] = [];
    const err = await (async () => {
      try {
        for await (const ev of provider.stream({ messages: [], maxTokens: 8 })) {
          if (ev.type === 'delta') seen.push(ev.text);
        }
        return null;
      } catch (e) {
        return e as LLMError;
      }
    })();
    expect(seen).toEqual(['第一', '第二']);
    expect(err).toMatchObject({ kind: 'network', raw: 'timeout:idle' });
    expect((err as LLMError).retryable).toBe(true);
  });

  it('Anthropic 同样有空闲超时', async () => {
    const f = fakeFetch([() => sseResponseFrom(stallAfter([anthropicChunk('第一')]))]);
    const provider = new AnthropicProvider(makeConfig({ ...FAST, kind: 'anthropic' }), 'k', f.fetch);
    await expect(collect(provider.stream({ messages: [], maxTokens: 8 }))).rejects.toMatchObject({
      kind: 'network',
      raw: 'timeout:idle',
    });
  });

  it('持续有数据就不会超时', async () => {
    const body = [openaiChunk('你'), openaiChunk('好'), 'data: [DONE]\n\n'].join('');
    const f = fakeFetch([() => sseResponseFrom(stallAfter([body]))]);
    const provider = new OpenAICompatibleProvider(makeConfig(FAST), 'k', f.fetch);
    const events = await collect(provider.stream({ messages: [], maxTokens: 8 }));
    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text)).toEqual(['你', '好']);
  });
});

describe('超时接入既有重试链路', () => {
  it('completeWithRetry 会按 network 重试，用尽后抛超时错误', async () => {
    const f = fakeFetch([() => sseResponseFrom(silentBody())]);
    const provider = new OpenAICompatibleProvider(makeConfig(FAST), 'k', f.fetch);
    const gate = new RateGate('t', { minIntervalMs: 0, sleep: async () => {} });
    const err = await completeWithRetry(
      provider,
      { messages: [], maxTokens: 8 },
      { gate, sleep: async () => {}, maxAttempts: 3 },
    ).catch((e) => e as LLMError);
    expect(err).toMatchObject({ kind: 'network', raw: 'timeout:first_byte' });
    expect(f.calls).toHaveLength(3); // 真的重试过，而不是一次就死
  });

  it('外部取消仍然是 aborted（不可重试）', async () => {
    const ac = new AbortController();
    const f = fakeFetch([() => sseResponseFrom(silentBody())]);
    // 超时给足，确保先被外部取消。
    const provider = new OpenAICompatibleProvider(makeConfig({ firstByteTimeoutMs: 5000, idleTimeoutMs: 5000 }), 'k', f.fetch);
    const p = collect(provider.stream({ messages: [], maxTokens: 8, signal: ac.signal }));
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toMatchObject({ kind: 'aborted' });
  });
});

describe('fetchWithTimeout（非流式整体超时）', () => {
  it('超时抛可重试的 network 错误并 abort 请求', async () => {
    let passed: AbortSignal | undefined;
    const hang: FetchLike = (_url, init) => {
      passed = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    };
    await expect(fetchWithTimeout(hang, 'https://x/y', {}, 20)).rejects.toMatchObject({
      kind: 'network',
      raw: 'timeout:request',
    });
    expect(passed?.aborted).toBe(true);
  });

  it('在超时前返回时不受影响，返回的响应仍可读', async () => {
    const ok: FetchLike = async () => new Response('hi', { status: 200 });
    const res = await fetchWithTimeout(ok, 'https://x/y', {}, 5000);
    expect(await res.text()).toBe('hi');
  });
});
