import { describe, expect, it } from 'vitest';
import { LLMError } from '@/llm/types';
import { classifyHttpError, getRateGate, parseRetryAfter, RateGate, resetRateGates, withRetry } from '@/llm/retry';

const noSleep = async () => {};

describe('classifyHttpError', () => {
  it('maps auth statuses', () => {
    expect(classifyHttpError(401, '{"error":{"message":"bad key"}}').kind).toBe('auth');
    expect(classifyHttpError(403, '').kind).toBe('auth');
    expect(classifyHttpError(401, '{"error":{"message":"bad key"}}').message).toContain('bad key');
  });

  it('maps 429 with Retry-After seconds and http-date', () => {
    const e = classifyHttpError(429, 'slow down', new Headers({ 'retry-after': '3' }));
    expect(e.kind).toBe('rate_limit');
    expect(e.retryAfterMs).toBe(3000);
    expect(e.status).toBe(429);
    expect(e.retryable).toBe(true);

    const date = new Date(Date.now() + 10_000).toUTCString();
    const e2 = classifyHttpError(429, '', { 'Retry-After': date });
    expect(e2.retryAfterMs).toBeGreaterThan(8000);
    expect(e2.retryAfterMs).toBeLessThanOrEqual(10_000);

    expect(classifyHttpError(429, '').retryAfterMs).toBeUndefined();
  });

  it('distinguishes context_length from bad_request', () => {
    expect(classifyHttpError(400, '{"error":{"message":"This model\'s maximum context length is 128000 tokens"}}').kind).toBe(
      'context_length',
    );
    expect(classifyHttpError(400, '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000"}}').kind).toBe(
      'context_length',
    );
    expect(classifyHttpError(413, 'input length exceeds').kind).toBe('context_length');
    expect(classifyHttpError(400, '{"error":{"message":"invalid model"}}').kind).toBe('bad_request');
    expect(classifyHttpError(422, 'nope').kind).toBe('bad_request');
    expect(classifyHttpError(404, 'nope').kind).toBe('bad_request');
  });

  it('maps server errors', () => {
    for (const s of [500, 502, 503, 408, 529]) expect(classifyHttpError(s, '').kind).toBe('server');
  });

  it('parseRetryAfter handles junk', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('abc')).toBeUndefined();
    expect(parseRetryAfter('1.5')).toBe(1500);
  });
});

describe('withRetry', () => {
  it('retries server errors with 1000·2^n schedule then succeeds', async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await withRetry(
      async (attempt) => {
        calls++;
        if (attempt < 3) throw new LLMError('server', 'boom', { status: 500 });
        return 'ok';
      },
      { sleep: async (ms) => void delays.push(ms) },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(4);
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it('gives up after 4 attempts for server/network errors', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new LLMError('network', 'down');
        },
        { sleep: noSleep },
      ),
    ).rejects.toMatchObject({ kind: 'network' });
    expect(calls).toBe(4);
  });

  it('rate_limit uses Retry-After when present, else 2000·2^n ± 20% jitter, up to 6 attempts', async () => {
    const delays: number[] = [];
    const retries: number[] = [];
    let calls = 0;
    await expect(
      withRetry(
        async (attempt) => {
          calls++;
          throw new LLMError('rate_limit', '429', {
            status: 429,
            retryAfterMs: attempt === 0 ? 5000 : undefined,
          });
        },
        {
          sleep: async (ms) => void delays.push(ms),
          random: () => 1, // +20%
          onRetry: (_e, attempt) => void retries.push(attempt),
        },
      ),
    ).rejects.toMatchObject({ kind: 'rate_limit' });
    expect(calls).toBe(6);
    expect(delays).toEqual([5000, 4800, 9600, 19200, 38400]);
    expect(retries).toEqual([0, 1, 2, 3, 4]);
  });

  it('jitter lower bound is -20%', async () => {
    const delays: number[] = [];
    await withRetry(
      async (attempt) => {
        if (attempt === 0) throw new LLMError('rate_limit', '429');
        return 1;
      },
      { sleep: async (ms) => void delays.push(ms), random: () => 0 },
    );
    expect(delays).toEqual([1600]);
  });

  it('caps delays at maxDelayMs and honours maxAttempts override', async () => {
    const delays: number[] = [];
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new LLMError('server', 'x');
        },
        { sleep: async (ms) => void delays.push(ms), maxDelayMs: 1500, maxAttempts: 3 },
      ),
    ).rejects.toBeInstanceOf(LLMError);
    expect(calls).toBe(3);
    expect(delays).toEqual([1000, 1500]);
  });

  it('never retries auth / bad_request / context_length / aborted', async () => {
    for (const kind of ['auth', 'bad_request', 'context_length', 'aborted'] as const) {
      let calls = 0;
      await expect(
        withRetry(
          async () => {
            calls++;
            throw new LLMError(kind, kind);
          },
          { sleep: noSleep },
        ),
      ).rejects.toMatchObject({ kind });
      expect(calls).toBe(1);
    }
  });

  it('wraps non-LLM errors as network and AbortError as aborted', async () => {
    await expect(
      withRetry(
        async () => {
          throw new TypeError('fetch failed');
        },
        { sleep: noSleep, maxAttempts: 1 },
      ),
    ).rejects.toMatchObject({ kind: 'network', message: 'fetch failed' });

    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    await expect(
      withRetry(async () => {
        throw abortErr;
      }),
    ).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('stops immediately when signal already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          return 1;
        },
        { signal: ac.signal },
      ),
    ).rejects.toMatchObject({ kind: 'aborted' });
    expect(calls).toBe(0);
  });
});

describe('RateGate', () => {
  function fakeClock() {
    let t = 1_000_000;
    const slept: number[] = [];
    return {
      now: () => t,
      sleep: async (ms: number) => {
        slept.push(ms);
        t += ms;
      },
      advance: (ms: number) => void (t += ms),
      slept,
    };
  }

  it('enforces minIntervalMs between request starts', async () => {
    const clock = fakeClock();
    const gate = new RateGate('x', { minIntervalMs: 500, now: clock.now, sleep: clock.sleep });
    await gate.acquire();
    expect(clock.slept).toEqual([]);
    await gate.acquire();
    expect(clock.slept).toEqual([500]);
    clock.advance(1000);
    await gate.acquire();
    expect(clock.slept).toEqual([500]);
  });

  it('waits out a 429 cooldown', async () => {
    const clock = fakeClock();
    const gate = new RateGate('x', { minIntervalMs: 0, now: clock.now, sleep: clock.sleep });
    gate.reportRateLimit(5000);
    expect(gate.cooldownUntil).toBe(clock.now() + 5000);
    await gate.acquire();
    expect(clock.slept).toEqual([5000]);
    // Default cooldown when Retry-After is absent, and longer cooldowns win.
    gate.reportRateLimit();
    gate.reportRateLimit(100);
    expect(gate.cooldownUntil).toBe(clock.now() + 2000);
  });

  it('serves waiters FIFO', async () => {
    const clock = fakeClock();
    const gate = new RateGate('x', { minIntervalMs: 100, now: clock.now, sleep: clock.sleep });
    const order: number[] = [];
    await Promise.all([
      gate.acquire().then(() => order.push(1)),
      gate.acquire().then(() => order.push(2)),
      gate.acquire().then(() => order.push(3)),
    ]);
    expect(order).toEqual([1, 2, 3]);
    expect(clock.slept).toEqual([100, 100]);
  });

  it('rejects with aborted when signal is aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const gate = new RateGate('x');
    await expect(gate.acquire(ac.signal)).rejects.toMatchObject({ kind: 'aborted' });
    // Gate must still be usable afterwards (queue released).
    await gate.acquire();
  });

  it('registry returns one gate per provider id', () => {
    resetRateGates();
    const a = getRateGate('deepseek');
    expect(getRateGate('deepseek')).toBe(a);
    expect(getRateGate('kimi')).not.toBe(a);
    resetRateGates();
    expect(getRateGate('deepseek')).not.toBe(a);
  });
});

describe('RateGate 冷却分组', () => {
  it('同组的两个池共享 429 冷却', async () => {
    resetRateGates();
    let t = 0;
    const now = () => t;
    const slept: number[] = [];
    const sleep = async (ms: number) => { slept.push(ms); t += ms; };
    // 任务池与聊天池是两把不同的 gate，但 cooldownGroup 相同。
    const task = getRateGate('p1#task', { cooldownGroup: 'p1', now, sleep, minIntervalMs: 0 });
    const chat = getRateGate('p1', { cooldownGroup: 'p1', now, sleep, minIntervalMs: 0 });

    task.reportRateLimit(5000);
    expect(chat.cooldownUntil).toBe(5000);
    await chat.acquire();
    expect(slept).toEqual([5000]);
  });

  it('不同 providerId 的冷却互不影响', async () => {
    resetRateGates();
    const now = () => 0;
    const sleep = async () => {};
    const a = getRateGate('pa#task', { cooldownGroup: 'pa', now, sleep });
    const b = getRateGate('pb#task', { cooldownGroup: 'pb', now, sleep });
    a.reportRateLimit(3000);
    expect(a.cooldownUntil).toBe(3000);
    expect(b.cooldownUntil).toBe(0);
  });
});
