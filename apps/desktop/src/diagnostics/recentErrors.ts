/**
 * 最近错误的环形缓冲。
 *
 * 用户报 bug 时最有价值的就是「崩之前发生了什么」，但我们不做任何自动上报：
 * 错误只留在内存里，只有用户主动点「导出诊断包」时才会落到文件里，且要先脱敏。
 */

export interface RecordedError {
  /** 毫秒时间戳 */
  at: number;
  /** 出错的位置，如「书架」「未捕获异常」 */
  scope: string;
  message: string;
  stack: string;
  route?: string;
}

/** 只留最近这么多条：够定位问题，又不会把内存和诊断包撑大。 */
export const MAX_RECENT_ERRORS = 50;

let buffer: RecordedError[] = [];

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || '未知错误';
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const m = (error as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error ?? '未知错误');
}

function stackOf(error: unknown): string {
  return error instanceof Error && error.stack ? error.stack : messageOf(error);
}

function currentRoute(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.location.hash || window.location.pathname || undefined;
}

/** 同一条错误在这个窗口内重复上报（比如既走 window.onerror 又走 console.error）只记一次。 */
const DEDUPE_WINDOW_MS = 200;

/** 记一条错误。任何地方都能调，重复调用只会挤掉最老的一条。 */
export function recordError(input: { error: unknown; scope?: string; route?: string; at?: number }): void {
  const at = input.at ?? Date.now();
  const message = messageOf(input.error);
  const last = buffer[buffer.length - 1];
  if (last && last.message === message && Math.abs(at - last.at) < DEDUPE_WINDOW_MS) return;
  buffer.push({
    at,
    scope: input.scope ?? '未标注',
    message,
    stack: stackOf(input.error),
    route: input.route ?? currentRoute(),
  });
  if (buffer.length > MAX_RECENT_ERRORS) buffer = buffer.slice(-MAX_RECENT_ERRORS);
}

/** 按时间正序取出（最老的在前）。 */
export function recentErrors(): RecordedError[] {
  return [...buffer];
}

export function clearRecentErrors(): void {
  buffer = [];
}

let uninstall: (() => void) | null = null;

/**
 * 捕获全局未处理错误与未处理的 Promise 拒绝。
 * 返回卸载函数；重复调用是幂等的（先卸载上一次）。
 */
export function installGlobalErrorCapture(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  uninstall?.();
  const onError = (e: ErrorEvent): void => {
    recordError({ error: e.error ?? e.message, scope: '未捕获异常' });
  };
  const onRejection = (e: PromiseRejectionEvent): void => {
    recordError({ error: e.reason, scope: '未处理的 Promise 拒绝' });
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  uninstall = () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    uninstall = null;
  };
  return uninstall;
}
