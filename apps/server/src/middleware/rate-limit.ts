import type { Context, MiddlewareHandler } from 'hono';
import type { AppDeps, AppEnv, RateLimitName, RateLimitRule } from '../context';
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

/** 内存滑动窗口限流器（单实例）。 */
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(private readonly rule: RateLimitRule) {}

  /** 返回 null 表示放行，否则返回建议的 Retry-After 秒数。 */
  hit(key: string, nowMs: number): number | null {
    this.sweep(nowMs);
    const windowStart = nowMs - this.rule.windowMs;
    let arr = this.hits.get(key);
    if (!arr) {
      arr = [];
      this.hits.set(key, arr);
    }
    while (arr.length && arr[0]! <= windowStart) arr.shift();
    if (arr.length >= this.rule.max) {
      return Math.max(1, Math.ceil((arr[0]! + this.rule.windowMs - nowMs) / 1000));
    }
    arr.push(nowMs);
    return null;
  }

  private sweep(nowMs: number): void {
    if (nowMs - this.lastSweep < this.rule.windowMs) return;
    this.lastSweep = nowMs;
    const windowStart = nowMs - this.rule.windowMs;
    for (const [k, arr] of this.hits) {
      if (!arr.length || arr[arr.length - 1]! <= windowStart) this.hits.delete(k);
    }
  }
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
  const limiter = new SlidingWindowLimiter(rule);
  return async (c, next) => {
    const retry = limiter.hit(keyFn(c), deps.clock.now().getTime());
    if (retry !== null) {
      c.header('Retry-After', String(retry));
      throw new ApiError('RATE_LIMITED', '请求过于频繁，请稍后再试', { retryAfterSeconds: retry });
    }
    await next();
  };
}
