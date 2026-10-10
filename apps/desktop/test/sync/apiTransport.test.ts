import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PublicApi } from '@/sync/api';

// TEST SIMULATED transport lifecycle, not real server or model results.
describe('TEST REST cancellation resource lifecycle', () => {
  it('completed requests do not cancel a released native request on later timeout', async () => {
    const outer = new AbortController();
    let nativeSignal: AbortSignal | undefined;
    const api = new PublicApi('https://TEST.invalid', async () => null, '', async (_url, init) => {
      nativeSignal = init?.signal ?? undefined;
      return Response.json({ test: true });
    });
    await expect(api.request('GET', '/TEST', { schema: z.object({ test: z.boolean() }), signal: outer.signal })).resolves.toEqual({ test: true });
    outer.abort();
    expect(nativeSignal?.aborted).toBe(false);
  });

  it('cancellation after headers cancels the live body without cancelling the released request', async () => {
    const outer = new AbortController();
    let nativeSignal: AbortSignal | undefined;
    let cancelled = false;
    let bodyStarted!: () => void;
    const started = new Promise<void>(resolve => { bodyStarted = resolve; });
    const api = new PublicApi('https://TEST.invalid', async () => null, '', async (_url, init) => {
      nativeSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream({
        pull() { bodyStarted(); },
        cancel() { cancelled = true; },
      }));
    });
    const result = api.request('GET', '/TEST', { schema: z.unknown(), signal: outer.signal });
    const assertion = expect(result).rejects.toMatchObject({ code: 'NETWORK', status: 0 });
    await started;
    await Promise.resolve();
    outer.abort();
    await assertion;
    expect(cancelled).toBe(true);
    expect(nativeSignal?.aborted).toBe(false);
  });

  it('cancellation before headers still reaches the native request', async () => {
    const outer = new AbortController();
    let requestStarted!: () => void;
    const started = new Promise<void>(resolve => { requestStarted = resolve; });
    let nativeSignal: AbortSignal | undefined;
    const api = new PublicApi('https://TEST.invalid', async () => null, '', (_url, init) => {
      nativeSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        nativeSignal!.addEventListener('abort', () => reject(new DOMException('TEST cancelled', 'AbortError')));
        requestStarted();
      });
    });
    const result = api.request('GET', '/TEST', { schema: z.unknown(), signal: outer.signal });
    const assertion = expect(result).rejects.toMatchObject({ code: 'NETWORK', status: 0 });
    await started;
    outer.abort();
    await assertion;
    expect(nativeSignal?.aborted).toBe(true);
  });
});
