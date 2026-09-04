/**
 * 结构化请求日志 + 指标采集（§4.3）。
 *
 * 一个中间件同时喂日志和指标：两者要的字段一样（方法 / 路由 / 状态码 / 延迟），
 * 分成两个中间件只会把计时写两遍。
 */
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../context';
import type { Env } from '../env';
import { ApiError } from '../lib/errors';
import { Metrics, UNMATCHED_ROUTE } from '../lib/metrics';

export type LogSink = (line: string) => void;

/** 路由模板；没匹配上任何路由时归到 `<unmatched>`，避免指标基数被扫描器撑爆。 */
export function routeLabel(c: Context<AppEnv>): string {
  let path: string;
  try {
    path = c.req.routePath;
  } catch {
    return UNMATCHED_ROUTE;
  }
  if (!path || path.endsWith('*')) return UNMATCHED_ROUTE;
  return path;
}

function statusOf(err: unknown): number {
  if (err instanceof ApiError) return err.status;
  if (err instanceof HTTPException) return err.status;
  return 500;
}

export interface ObservabilityOptions {
  metrics?: Metrics;
  sink?: LogSink;
}

/**
 * 记录一条请求日志并累加指标。
 * `LOG_FORMAT=off` 时只采指标不打日志；`json` 输出一行 JSON（给 Loki / CloudWatch），
 * `text` 输出人读格式（本地开发）。
 */
export function observability(env: Env, opts: ObservabilityOptions = {}): MiddlewareHandler<AppEnv> {
  const metrics = opts.metrics;
  const sink = opts.sink ?? ((line: string) => console.log(line));
  return async (c, next) => {
    const started = performance.now();
    metrics?.begin();
    let status = 0;
    try {
      await next();
      status = c.res.status;
    } catch (e) {
      status = statusOf(e);
      throw e;
    } finally {
      metrics?.end();
      const ms = performance.now() - started;
      const route = routeLabel(c);
      metrics?.observe(c.req.method, route, status, ms / 1000);
      if (env.logFormat !== 'off') {
        const user = c.get('user');
        const rec = {
          time: new Date().toISOString(),
          level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
          method: c.req.method,
          path: c.req.path,
          route,
          status,
          durationMs: Math.round(ms * 1000) / 1000,
          requestId: c.get('requestId') ?? null,
          userId: user?.id ?? null,
          ip: c.get('ip') ?? null,
        };
        sink(env.logFormat === 'json' ? JSON.stringify(rec) : formatText(rec));
      }
    }
  };
}

type Record_ = {
  time: string;
  level: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestId: string | null;
  userId: string | null;
  ip: string | null;
};

function formatText(r: Record_): string {
  const who = r.userId ? ` user=${r.userId}` : '';
  return `${r.time} ${r.level.toUpperCase()} ${r.method} ${r.path} ${r.status} ${r.durationMs}ms req=${r.requestId ?? '-'}${who} ip=${r.ip ?? '-'}`;
}
