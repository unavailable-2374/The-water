/**
 * 请求超时（P0-7）。
 *
 * 两个互相独立的计时器：
 * - **首字节超时**：从发起请求算到收到第一块数据（SSE 的第一条消息）。覆盖
 *   「连上了但一直不回」以及「fetch 永远不 resolve」两种挂死。
 * - **流空闲超时**：首块数据之后，相邻两块数据之间的最长间隔。覆盖
 *   「发了几个块之后静默」。
 *
 * 超时一律归类为可重试的 `network` 错误，交给 `withRetry` 退避重试；同时通过
 * 内部 `AbortController` 真正中止底层请求（桌面端是 @tauri-apps/plugin-http 的
 * fetch），而不是只让 Promise reject、连接继续挂着。
 */
import { LLMError, type FetchLike, type ProviderConfig } from './types';
import { isAbortError, toLLMError } from './retry';
import { DEFAULT_FIRST_BYTE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS } from './config';

export type TimeoutPhase = 'first_byte' | 'idle' | 'request';

export interface RequestTimeouts {
  /** 首字节超时（毫秒），<=0 表示不限制。 */
  firstByteMs: number;
  /** 流空闲超时（毫秒），<=0 表示不限制。 */
  idleMs: number;
  /** 整体超时（毫秒）：非流式调用用，流式调用不设（长文生成本来就久）。 */
  overallMs?: number;
}

const PHASE_LABEL: Record<TimeoutPhase, string> = {
  first_byte: '首字节',
  idle: '流空闲',
  request: '请求',
};

/** 超时错误统一带 `timeout:<phase>` 标记，便于 UI 与测试识别。 */
export function timeoutError(phase: TimeoutPhase, ms: number): LLMError {
  return new LLMError('network', `${PHASE_LABEL[phase]}超时：${ms}ms 内没有收到数据`, { raw: `timeout:${phase}` });
}

export function isTimeoutError(err: unknown): boolean {
  return err instanceof LLMError && err.kind === 'network' && typeof err.raw === 'string' && err.raw.startsWith('timeout:');
}

function positive(v: number | null | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** 供应商配置 → 实际生效的超时；缺列 / 非法值回落到 config.ts 的默认值。 */
export function resolveTimeouts(config: Pick<ProviderConfig, 'firstByteTimeoutMs' | 'idleTimeoutMs'>): RequestTimeouts {
  return {
    firstByteMs: positive(config.firstByteTimeoutMs) ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS,
    idleMs: positive(config.idleTimeoutMs) ?? DEFAULT_IDLE_TIMEOUT_MS,
  };
}

/**
 * 一次请求的计时器 + 中止器。生命周期：`start()` → 若干次 `poke()` → `dispose()`。
 * 任何一个计时器到点都会 abort 内部 signal，并让 `race()` 抛出可重试的 network 错误。
 */
export class RequestTimer {
  private readonly controller = new AbortController();
  private readonly timeouts: RequestTimeouts;
  private readonly outer: AbortSignal | undefined;
  private readonly expiry: Promise<never>;
  private rejectExpiry: ((err: unknown) => void) | null = null;
  private phaseTimer: ReturnType<typeof setTimeout> | null = null;
  private overallTimer: ReturnType<typeof setTimeout> | null = null;
  private failure: LLMError | null = null;
  private disposed = false;
  private readonly onOuterAbort = () => this.fail(new LLMError('aborted', 'Request aborted'));

  constructor(timeouts: RequestTimeouts, outer?: AbortSignal | null) {
    this.timeouts = timeouts;
    this.outer = outer ?? undefined;
    this.expiry = new Promise<never>((_resolve, reject) => {
      this.rejectExpiry = reject;
    });
    // 没被 race 消费时也不要变成未处理的拒绝。
    this.expiry.catch(() => undefined);
    if (this.outer) {
      if (this.outer.aborted) this.fail(new LLMError('aborted', 'Request aborted'));
      else this.outer.addEventListener('abort', this.onOuterAbort, { once: true });
    }
  }

  /** 传给底层 fetch 的 signal：超时或外部取消都会让它 abort。 */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** 已经触发的失败原因（超时或中止），未触发时为 null。 */
  get failureReason(): LLMError | null {
    return this.failure;
  }

  /** 发起请求时调用：启动首字节计时（以及可选的整体计时）。 */
  start(): void {
    this.arm('first_byte', this.timeouts.firstByteMs);
    const overall = positive(this.timeouts.overallMs);
    if (overall !== undefined) {
      this.overallTimer = schedule(() => this.fail(timeoutError('request', overall)), overall);
    }
  }

  /** 收到一块数据：解除首字节计时，并重置空闲计时。 */
  poke(): void {
    if (this.disposed || this.failure) return;
    this.arm('idle', this.timeouts.idleMs);
  }

  /**
   * 把一个 Promise 与超时竞速。超时后原 Promise 的拒绝会被吞掉（底层 fetch 被 abort
   * 之后必然拒绝），避免变成未处理异常。
   */
  race<T>(p: Promise<T>): Promise<T> {
    p.then(undefined, () => undefined);
    return Promise.race([p, this.expiry]);
  }

  /**
   * 把底层抛出的错误翻译成对上层有意义的 LLMError：
   * 超时导致的 AbortError 必须变回 network（可重试），而不是 aborted（不可重试）。
   */
  toError(err: unknown, outer?: AbortSignal | null): LLMError {
    if (err instanceof LLMError && err.kind !== 'aborted') return err;
    if (outer?.aborted) return new LLMError('aborted', 'Request aborted', { cause: err });
    if (this.failure) return this.failure;
    if (isAbortError(err)) return new LLMError('aborted', 'Request aborted', { cause: err });
    return toLLMError(err, outer);
  }

  /**
   * 请求结束（成功、失败或提前退出）时调用：停表。
   * `abort` 默认 true，即顺手中止底层连接；只有「响应已拿到、还要继续读 body」
   * 的场景才传 false。
   */
  dispose(abort = true): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimers();
    this.outer?.removeEventListener('abort', this.onOuterAbort);
    if (abort && !this.controller.signal.aborted) this.controller.abort();
  }

  private arm(phase: TimeoutPhase, ms: number): void {
    this.clearPhaseTimer();
    if (this.disposed) return;
    const timeout = positive(ms);
    if (timeout === undefined) return;
    this.phaseTimer = schedule(() => this.fail(timeoutError(phase, timeout)), timeout);
  }

  private fail(err: LLMError): void {
    if (this.failure) return;
    this.failure = err;
    this.clearTimers();
    if (!this.controller.signal.aborted) this.controller.abort();
    this.rejectExpiry?.(err);
  }

  private clearPhaseTimer(): void {
    if (this.phaseTimer !== null) {
      clearTimeout(this.phaseTimer);
      this.phaseTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearPhaseTimer();
    if (this.overallTimer !== null) {
      clearTimeout(this.overallTimer);
      this.overallTimer = null;
    }
  }
}

/** setTimeout + unref（Node 下不要因为计时器而拖住进程退出）。 */
function schedule(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const t = setTimeout(fn, ms);
  (t as unknown as { unref?: () => void }).unref?.();
  return t;
}

/**
 * 用计时器包住一个异步迭代：每取到一项就重置空闲计时；超时则抛出可重试的 network 错误。
 * 竞速而不是依赖底层流响应 abort，这样即使传输层不理会 signal 也不会永久挂起。
 */
export async function* guardedIteration<T>(source: AsyncIterable<T>, timer: RequestTimer): AsyncGenerator<T> {
  const it = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      const r = await timer.race(it.next());
      if (r.done) return;
      timer.poke();
      yield r.value;
    }
  } finally {
    // 不能 await：迭代器很可能正卡在一个永不返回的 read 上，等它会让超时重新变成挂起。
    // signal 已经 abort，真实传输层会自行收敛。
    void Promise.resolve(it.return?.(undefined)).catch(() => undefined);
  }
}

/**
 * 非流式（一次性）请求的整体超时封装：超时后真正 abort 底层请求，
 * 并抛出可重试的 network 错误。
 */
export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  outer?: AbortSignal | null,
): Promise<Response> {
  const timer = new RequestTimer({ firstByteMs: 0, idleMs: 0, overallMs: timeoutMs }, outer);
  timer.start();
  try {
    return await timer.race(fetchImpl(url, { ...init, signal: timer.signal }));
  } catch (err) {
    throw timer.toError(err, outer);
  } finally {
    // 响应已经拿到时不能 abort，否则读 body 会被打断。
    timer.dispose(false);
  }
}
