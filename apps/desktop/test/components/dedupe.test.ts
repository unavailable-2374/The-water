import { afterEach, describe, expect, it, vi } from 'vitest';
import { dedupe, inflightCount, resetInflight } from '@/components/data/dedupe';

afterEach(() => resetInflight());

describe('dedupe', () => {
  it('同一把钥匙上的并发请求只真正跑一次', async () => {
    const run = vi.fn(async () => 42);
    const [a, b] = await Promise.all([dedupe('k', run), dedupe('k', run)]);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('不同钥匙互不影响', async () => {
    const run = vi.fn(async () => 1);
    await Promise.all([dedupe('a', run), dedupe('b', run)]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('跑完之后在途表清空，下一次是全新的请求', async () => {
    const run = vi.fn(async () => 1);
    await dedupe('k', run);
    expect(inflightCount()).toBe(0);
    await dedupe('k', run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('失败也会从在途表里摘掉，不会把错误一直缓存住', async () => {
    const boom = async () => { throw new Error('boom'); };
    await expect(dedupe('k', boom)).rejects.toThrow('boom');
    expect(inflightCount()).toBe(0);
  });

  it('只有一个订阅者时，它一取消底层请求就被掐掉', async () => {
    const ac = new AbortController();
    const box: { signal: AbortSignal | null } = { signal: null };
    const p = dedupe('k', (signal) => { box.signal = signal; return new Promise<number>(() => undefined); }, ac.signal);
    void p.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    ac.abort();
    expect(box.signal?.aborted).toBe(true);
    expect(inflightCount()).toBe(0);
  });

  it('还有别的订阅者在等时，先走的那个不会连累底层请求', async () => {
    const first = new AbortController();
    const second = new AbortController();
    const box: { signal: AbortSignal | null; settle: ((v: number) => void) | null } = { signal: null, settle: null };
    const runner = (signal: AbortSignal): Promise<number> => {
      box.signal = signal;
      return new Promise<number>((resolve) => { box.settle = resolve; });
    };
    const pA = dedupe('k', runner, first.signal);
    const pB = dedupe('k', runner, second.signal);
    void pA.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    first.abort();
    expect(box.signal?.aborted).toBe(false);
    box.settle?.(7);
    await expect(pB).resolves.toBe(7);
  });
});
