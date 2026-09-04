/**
 * §4.5：限流下沉到共享存储。
 * 关键断言是「两个实例共用一份配额」——从前每个进程一份内存 Map，两个实例就等于配额翻倍。
 */
import { describe, expect, it } from 'bun:test';
import { createApp } from '../src/app';
import type { AppDeps, RateLimitName, RateLimitRule } from '../src/context';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { rateLimitCounters } from '../src/db/schema';
import { testEnv } from '../src/env';
import { memoryMailer } from '../src/lib/mailer';
import { noopModerator } from '../src/lib/moderation';
import { FakeClock, MINUTE } from '../src/lib/time';
import { gcRateLimits, SharedWindowLimiter } from '../src/middleware/rate-limit';

/** 同一个库上开两个「实例」，模拟滚动部署时并存的两个进程。 */
function twoInstances(rateLimits: Partial<Record<RateLimitName, RateLimitRule>>) {
  const { db } = createDb(':memory:');
  runMigrations(db);
  const clock = new FakeClock();
  const mk = (): AppDeps => ({ db, env: testEnv(), clock, moderator: noopModerator, mailer: memoryMailer(), rateLimits });
  const a = mk();
  const b = mk();
  return { db, clock, a: createApp(a), b: createApp(b) };
}

const login = (app: ReturnType<typeof createApp>) =>
  app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@example.com', password: 'password123' }),
  });

describe('限流：共享存储', () => {
  it('两个实例共用一份配额，配额不会翻倍', async () => {
    const { a, b } = twoInstances({ login: { max: 3, windowMs: MINUTE } });
    // 前三次分摊在两个实例上，全部放行（401 是凭据错，说明没被限流挡掉）。
    expect((await login(a)).status).toBe(401);
    expect((await login(b)).status).toBe(401);
    expect((await login(a)).status).toBe(401);
    // 第四次无论打到哪个实例都该被挡。
    const limited = await login(b);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBeTruthy();
    expect((await login(a)).status).toBe(429);
  });

  it('表按「主体 × 窗口」计数，不是一次请求一行', async () => {
    const { db, a } = twoInstances({ login: { max: 50, windowMs: MINUTE } });
    for (let i = 0; i < 8; i++) await login(a);
    const rows = db.select().from(rateLimitCounters).all();
    expect(rows.length).toBe(1);
    expect(rows[0]!.count).toBe(8);
    expect(rows[0]!.bucket).toBe('login:ip:unknown');
  });

  it('窗口滚过之后配额恢复', async () => {
    const { clock, a } = twoInstances({ login: { max: 2, windowMs: MINUTE } });
    await login(a);
    await login(a);
    expect((await login(a)).status).toBe(429);
    // 跨过两个窗口，上一窗口的权重也归零。
    clock.advance(2 * MINUTE);
    expect((await login(a)).status).toBe(401);
  });

  it('gcRateLimits 删掉过期计数行，表不会只增不减', () => {
    const { db } = createDb(':memory:');
    runMigrations(db);
    const now = 10 * MINUTE;
    db.insert(rateLimitCounters)
      .values([
        { bucket: 'read:ip:1.2.3.4', windowStart: 0, count: 5, windowMs: MINUTE },
        { bucket: 'read:ip:5.6.7.8', windowStart: now, count: 1, windowMs: MINUTE },
        // 窗口更长的规则，同样的 window_start 还没到该删的时候。
        { bucket: 'report:ip:9.9.9.9', windowStart: 0, count: 1, windowMs: 60 * MINUTE },
      ])
      .run();
    expect(gcRateLimits(db, now)).toBe(1);
    const left = db.select().from(rateLimitCounters).all().map((r) => r.bucket);
    expect(left.sort()).toEqual(['read:ip:5.6.7.8', 'report:ip:9.9.9.9']);
  });

  it('滑动窗口计数器：上一窗口的余量按比例计入', () => {
    const { db } = createDb(':memory:');
    runMigrations(db);
    const limiter = new SharedWindowLimiter(db, 'read', { max: 10, windowMs: MINUTE });
    // 第一个窗口打满 10 次。
    for (let i = 0; i < 10; i++) limiter.hit('ip:x', i);
    expect(limiter.hit('ip:x', 100)).not.toBeNull();
    // 进入下一个窗口的 10% 处：上一窗口按 90% 计入 = 9，仍只剩 1 个额度。
    expect(limiter.hit('ip:x', MINUTE + 6_000)).toBeNull();
    expect(limiter.hit('ip:x', MINUTE + 6_000)).not.toBeNull();
    // 到下一个窗口的 95% 处：上一窗口只按 5% 计入，额度基本恢复。
    expect(limiter.hit('ip:x', MINUTE + 57_000)).toBeNull();
  });
});
