import type { FetchLike, ProviderConfig, StreamEvent } from '@/llm/types';

const enc = new TextEncoder();

/** Build a ReadableStream that emits the given chunks (strings or bytes) in order. */
export function chunkedStream(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      const c = chunks[i++]!;
      controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
    },
  });
}

export function sseResponse(chunks: Array<string | Uint8Array>, init: ResponseInit = {}): Response {
  return new Response(chunkedStream(chunks), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    ...init,
  });
}

/** Encode a list of `data:` events (objects → JSON) as one SSE body string. */
export function sseBody(events: Array<{ event?: string; data: unknown }>): string {
  return events
    .map((e) => {
      const data = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
      return (e.event ? `event: ${e.event}\n` : '') + `data: ${data}\n\n`;
    })
    .join('');
}

export interface FakeFetchCall {
  url: string;
  init: RequestInit | undefined;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** A FetchLike that records calls and returns scripted responses in order (last one repeats). */
export function fakeFetch(responses: Array<Response | (() => Response | Promise<Response>) | Error>): {
  fetch: FetchLike;
  calls: FakeFetchCall[];
} {
  const calls: FakeFetchCall[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      init,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r() : r;
  };
  return { fetch, calls };
}

export function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'p1',
    name: 'Test',
    kind: 'openai_compatible',
    baseUrl: 'https://api.example.com/v1',
    model: 'test-model',
    contextWindow: 128000,
    maxOutputTokens: 8192,
    jsonMode: 'json_object',
    temperature: 0.8,
    extraHeaders: {},
    secretRef: 'env:TEST_KEY',
    isDefault: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

export async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}
