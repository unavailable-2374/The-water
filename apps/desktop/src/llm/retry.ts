import { LLMError } from './types';

// ---------------------------------------------------------------------------
// HTTP error classification
// ---------------------------------------------------------------------------

const CONTEXT_LENGTH_RE = /context|maximum context length|too many tokens|prompt is too long|input length/i;

type HeadersLike = Headers | Record<string, string | undefined> | null | undefined;

function getHeader(headers: HeadersLike, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined;
  }
  const rec = headers as Record<string, string | undefined>;
  const lower = name.toLowerCase();
  for (const key of Object.keys(rec)) {
    if (key.toLowerCase() === lower) return rec[key];
  }
  return undefined;
}

/** Parse a `Retry-After` header value (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const s = value.trim();
  if (s === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.max(0, Math.round(parseFloat(s) * 1000));
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return Math.max(0, t - now);
  return undefined;
}

/** Best-effort extraction of a human-readable message from a JSON error body. */
export function extractErrorMessage(bodyText: string): string | undefined {
  const trimmed = bodyText.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const obj = parsed as Record<string, unknown>;
    const err = obj.error;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
      const msg = (err as Record<string, unknown>).message;
      if (typeof msg === 'string') return msg;
    }
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.detail === 'string') return obj.detail;
  } catch {
    /* not JSON */
  }
  return undefined;
}

export function classifyHttpError(status: number, bodyText: string, headers?: HeadersLike): LLMError {
  const raw = bodyText.length > 4000 ? bodyText.slice(0, 4000) : bodyText;
  const detail = extractErrorMessage(bodyText) ?? (raw.trim() || 'no response body');
  const message = `HTTP ${status}: ${detail}`;

  if (status === 401 || status === 403) return new LLMError('auth', message, { status, raw });
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(getHeader(headers, 'retry-after'));
    return new LLMError('rate_limit', message, { status, retryAfterMs, raw });
  }
  if (status === 400 || status === 413 || status === 422) {
    if (CONTEXT_LENGTH_RE.test(bodyText)) return new LLMError('context_length', message, { status, raw });
    return new LLMError('bad_request', message, { status, raw });
  }
  if (status === 408 || status === 529 || status >= 500) return new LLMError('server', message, { status, raw });
  return new LLMError('bad_request', message, { status, raw });
}

/** Convert any thrown value into an LLMError (aborts → 'aborted', unknown → 'network'). */
export function toLLMError(err: unknown, signal?: AbortSignal | null): LLMError {
  if (err instanceof LLMError) return err;
  if (signal?.aborted || isAbortError(err)) {
    return new LLMError('aborted', 'Request aborted', { cause: err });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new LLMError('network', message, { cause: err });
}

export function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    ((err as { name?: unknown }).name === 'AbortError' || (err as { name?: unknown }).name === 'TimeoutError')
  );
}

// ---------------------------------------------------------------------------
// Retry with backoff
// ---------------------------------------------------------------------------

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export const defaultSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LLMError('aborted', 'Request aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new LLMError('aborted', 'Request aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export interface RetryOptions {
  /** Overrides the per-kind default (rate_limit: 6, server/network: 4). */
  maxAttempts?: number;
  /** Base delay for server/network backoff (default 1000ms → 1s, 2s, 4s…). */
  baseDelayMs?: number;
  /** Base delay for rate_limit backoff without Retry-After (default 2000ms ± 20% jitter). */
  rateLimitBaseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (err: LLMError, attempt: number, delayMs: number) => void;
  sleep?: SleepFn;
  /** Random source in [0,1) for jitter; injectable for tests. */
  random?: () => number;
}

export const RATE_LIMIT_MAX_ATTEMPTS = 6;
export const SERVER_MAX_ATTEMPTS = 4;

/**
 * Run `fn` until it succeeds or a non-retryable/attempt-exhausted error occurs.
 * `attempt` is 0-based. Only `LLMError.retryable` kinds are retried.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const maxDelay = opts.maxDelayMs ?? 60_000;

  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw new LLMError('aborted', 'Request aborted');
    try {
      return await fn(attempt);
    } catch (raw) {
      const err = toLLMError(raw, opts.signal);
      if (!err.retryable) throw err;

      const kindMax = err.kind === 'rate_limit' ? RATE_LIMIT_MAX_ATTEMPTS : SERVER_MAX_ATTEMPTS;
      const maxAttempts = opts.maxAttempts ?? kindMax;
      if (attempt + 1 >= maxAttempts) throw err;

      let delay: number;
      if (err.kind === 'rate_limit') {
        if (err.retryAfterMs !== undefined) {
          delay = err.retryAfterMs;
        } else {
          const base = (opts.rateLimitBaseDelayMs ?? 2000) * 2 ** attempt;
          const jitter = (random() * 2 - 1) * 0.2; // ±20%
          delay = Math.round(base * (1 + jitter));
        }
      } else {
        delay = (opts.baseDelayMs ?? 1000) * 2 ** attempt;
      }
      delay = Math.max(0, Math.min(delay, maxDelay));
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay, opts.signal);
    }
  }
}

// ---------------------------------------------------------------------------
// RateGate — per-provider pacing shared by all callers (reader chat, generation jobs…)
// ---------------------------------------------------------------------------

export interface RateGateOptions {
  /** Minimum spacing between request starts (default 300ms). */
  minIntervalMs?: number;
  /** Cooldown applied on a 429 without Retry-After (default 2000ms). */
  defaultCooldownMs?: number;
  now?: () => number;
  sleep?: SleepFn;
}

export class RateGate {
  readonly id: string;
  readonly minIntervalMs: number;
  private readonly defaultCooldownMs: number;
  private readonly now: () => number;
  private readonly sleep: SleepFn;
  private nextAllowedAt = 0;
  private _cooldownUntil = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(id: string, opts: RateGateOptions = {}) {
    this.id = id;
    this.minIntervalMs = opts.minIntervalMs ?? 300;
    this.defaultCooldownMs = opts.defaultCooldownMs ?? 2000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  get cooldownUntil(): number {
    return this._cooldownUntil;
  }

  /** Resolves when the caller may start a request. Callers are served FIFO. */
  async acquire(signal?: AbortSignal): Promise<void> {
    const prev = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((r) => {
      release = r;
    });
    try {
      await prev;
      if (signal?.aborted) throw new LLMError('aborted', 'Request aborted');
      const waitUntil = Math.max(this.nextAllowedAt, this._cooldownUntil);
      const wait = waitUntil - this.now();
      if (wait > 0) await this.sleep(wait, signal);
      this.nextAllowedAt = this.now() + this.minIntervalMs;
    } finally {
      release();
    }
  }

  /** Record a 429; subsequent `acquire` calls wait until the cooldown ends. */
  reportRateLimit(retryAfterMs?: number): void {
    const ms = retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : this.defaultCooldownMs;
    this._cooldownUntil = Math.max(this._cooldownUntil, this.now() + ms);
  }
}

const gates = new Map<string, RateGate>();

export function getRateGate(providerId: string, opts?: RateGateOptions): RateGate {
  let gate = gates.get(providerId);
  if (!gate) {
    gate = new RateGate(providerId, opts);
    gates.set(providerId, gate);
  }
  return gate;
}

/** Test helper: drop all registered gates. */
export function resetRateGates(): void {
  gates.clear();
}
