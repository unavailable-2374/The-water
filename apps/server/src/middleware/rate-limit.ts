import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppDeps, AppEnv, RateLimitName, RateLimitRule } from '../context';
import { changes, type Db } from '../db/client';
import { rateLimitCounters } from '../db/schema';
import { ApiError } from '../lib/errors';
import { MINUTE, HOUR } from '../lib/time';

export const DEFAULT_RATE_LIMITS: Record<RateLimitName, RateLimitRule> = {
  login: { max: 10, windowMs: MINUTE },
  register: { max: 5, windowMs: HOUR },
  blobs: { max: 60, windowMs: MINUTE },
  read: { max: 300, windowMs: MINUTE },
  comment: { max: 10, windowMs: MINUTE },
  social: { max: 60, windowMs: MINUTE },
  /** 举报：登录用户 5/小时，避免零成本刷爆审核队列。 */
  report: { max: 5, windowMs: HOUR },
  fork: { max: 20, windowMs: HOUR },
  /** 通用写端点（创建作品 / 版本 / 提交）。 */
  write: { max: 120, windowMs: MINUTE },
  /** 找回密码 / 改密 / 发验证邮件。 */
  password: { max: 5, windowMs: HOUR },
  /** 网页路由读限流（按 IP）。 */
  web: { max: 240, windowMs: MINUTE },
};

/**
 * 共享滑动窗口限流器：计数落在 `rate_limit_counters` 表里，多实例共用一份配额。
 *
 * 算法是「滑动窗口计数器」而不是「滑动日志」：每个 (主体, 窗口) 一行、只做自增，
 * 一次请求不再写一行。估算值 = 上一窗口计数 × 剩余权重 + 当前窗口计数，
 * 误差在窗口边界处几个百分点，换来的是「表的行数 = 活跃主体数 × 2」这个上界。
 *
 * 清理有两道：
 * 1. 本类自带节流清扫，每个限流器每 `SWEEP_EVERY_MS` 最多删一次过期行（删的是全表过期行，
 *    不只是自己那条规则的，所以只要有任何一条规则还在被调用，全表就在被清理）；
 * 2. `gcRateLimits()` 挂在 index.ts 的每小时 GC 上，兜住「服务空转没人请求」的情况。
 * 判定过期用行里存着的 `window_ms`，改配置后旧行也能被正确清掉。
 */
const SWEEP_EVERY_MS = MINUTE;

export class SharedWindowLimiter {
  private lastSweep = 0;

  constructor(
    private readonly db: Db,
    private readonly name: string,
    private readonly rule: RateLimitRule,
  ) {}

  /** 返回 null 表示放行，否则返回建议的 Retry-After 秒数。 */
  hit(key: string, nowMs: number): number | null {
    const w = this.rule.windowMs;
    const bucket = `${this.name}:${key}`;
    const start = Math.floor(nowMs / w) * w;
    const prev = start - w;
    this.sweep(nowMs);

    const rows = this.db
      .select({ windowStart: rateLimitCounters.windowStart, count: rateLimitCounters.count })
      .from(rateLimitCounters)
      .where(and(eq(rateLimitCounters.bucket, bucket), inArray(rateLimitCounters.windowStart, [prev, start])))
      .all();
    let cur = 0;
    let old = 0;
    for (const r of rows) {
      if (r.windowStart === start) cur = r.count;
      else old = r.count;
    }
    // 上一窗口还压在滑动窗口里的比例。
    const weight = (w - (nowMs - start)) / w;
    if (old * weight + cur >= this.rule.max) {
      return Math.max(1, Math.ceil((start + w - nowMs) / 1000));
    }

    this.db
      .insert(rateLimitCounters)
      .values({ bucket, windowStart: start, count: 1, windowMs: w })
      .onConflictDoUpdate({
        target: [rateLimitCounters.bucket, rateLimitCounters.windowStart],
        set: { count: sql`${rateLimitCounters.count} + 1` },
      })
      .run();
    return null;
  }

  private sweep(nowMs: number): void {
    if (nowMs - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = nowMs;
    gcRateLimits(this.db, nowMs);
  }
}

/** 删掉已经不可能再被计入任何滑动窗口的计数行；返回删除行数。 */
export function gcRateLimits(db: Db, nowMs: number = Date.now()): number {
  return changes(
    db
      .delete(rateLimitCounters)
      .where(sql`${rateLimitCounters.windowStart} + ${rateLimitCounters.windowMs} * 2 < ${nowMs}`)
      .run(),
  );
}

type KeyFn = (c: Context<AppEnv>) => string;

export const keyByIp: KeyFn = (c) => `ip:${c.get('ip')}`;
export const keyByUser: KeyFn = (c) => {
  const u = c.get('user');
  return u ? `user:${u.id}` : `ip:${c.get('ip')}`;
};

export function rateLimit(deps: AppDeps, name: RateLimitName, keyFn: KeyFn): MiddlewareHandler<AppEnv> {
  if (deps.rateLimits === false) return async (_c, next) => next();
  const rule = deps.rateLimits[name] ?? DEFAULT_RATE_LIMITS[name];
  const limiter = new SharedWindowLimiter(deps.db, name, rule);
  return async (c, next) => {
    const retry = limiter.hit(keyFn(c), deps.clock.now().getTime());
    if (retry !== null) {
      c.header('Retry-After', String(retry));
      throw new ApiError('RATE_LIMITED', '请求过于频繁，请稍后再试', { retryAfterSeconds: retry });
    }
    await next();
  };
}
