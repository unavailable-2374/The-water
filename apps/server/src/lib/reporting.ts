/**
 * 错误上报出口（§4.3 第 4 条）。
 *
 * **这里只有接口与开关，没有 Sentry SDK**：绝大多数部署（自建、单机 SQLite）不需要它，
 * 为它们平白加一个几百 KB 的依赖和一条出网连接不划算。
 * 真要接的时候，装 `@sentry/bun` 后在 index.ts 里调一次 `setErrorTransport()` 即可，
 * 本文件与调用方都不用改：
 *
 * ```ts
 * import * as Sentry from '@sentry/bun';
 * Sentry.init({ dsn: env.sentryDsn, environment: env.sentryEnvironment });
 * setErrorTransport((r) => Sentry.captureException(r.error, { tags: { requestId: r.requestId ?? '' } }));
 * ```
 */
import type { Env } from '../env';

export interface ErrorReport {
  error: unknown;
  requestId?: string | null;
  method?: string;
  path?: string;
  status?: number;
  userId?: string | null;
}

export interface ErrorReporter {
  /** 'off' | 'log' | 'sentry'。 */
  readonly mode: string;
  capture(report: ErrorReport): void;
}

export type ErrorTransport = (report: ErrorReport) => void;

let transport: ErrorTransport | null = null;

/** 注册真正的上报实现（Sentry SDK 等）。传 null 撤销。 */
export function setErrorTransport(t: ErrorTransport | null): void {
  transport = t;
}

export function hasErrorTransport(): boolean {
  return transport !== null;
}

let warned = false;

export function createErrorReporter(env: Env, sink: (line: string) => void = (l) => console.error(l)): ErrorReporter {
  const mode = env.errorReporting;
  return {
    mode,
    capture(report) {
      if (mode === 'off') return;
      if (mode === 'sentry') {
        if (transport) {
          try {
            transport(report);
          } catch (e) {
            sink(`[error-report] 上报出口自身抛错：${e instanceof Error ? e.message : String(e)}`);
          }
          return;
        }
        if (!warned) {
          warned = true;
          sink('[error-report] ERROR_REPORTING=sentry 但没有注册上报出口（未安装 SDK），已降级为本地打印');
        }
      }
      const err = report.error;
      const line = JSON.stringify({
        kind: 'error-report',
        time: new Date().toISOString(),
        dsnConfigured: env.sentryDsn !== '',
        environment: env.sentryEnvironment,
        requestId: report.requestId ?? null,
        method: report.method ?? null,
        path: report.path ?? null,
        status: report.status ?? null,
        userId: report.userId ?? null,
        name: err instanceof Error ? err.name : typeof err,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      sink(line);
    },
  };
}

/** 只给测试用：重置「没装 SDK」的一次性告警。 */
export function resetReporterWarningForTest(): void {
  warned = false;
}
