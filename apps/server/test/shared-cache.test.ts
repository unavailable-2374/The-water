/**
 * §4.5：榜单缓存下沉到共享存储。
 * 从前 `LeaderboardCache` 是每个实例一份内存 Map，两个实例会在 TTL 内给出两份不同的榜单。
 */
import { describe, expect, it } from 'bun:test';
import type { AppDeps } from '../src/context';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { cacheEntries } from '../src/db/schema';
import { testEnv } from '../src/env';
import { gcCache, getCached, invalidateCache, putCache } from '../src/lib/cache';
import { memoryMailer } from '../src/lib/mailer';
import { noopModerator } from '../src/lib/moderation';
import { FakeClock, MINUTE } from '../src/lib/time';

function twoInstances() {
  const { db } = createDb(':memory:');
  runMigrations(db);
  const clock = new FakeClock();
  const mk = (): AppDeps => ({ db, env: testEnv(), clock, moderator: noopModerator, mailer: memoryMailer(), rateLimits: false });
  return { db, clock, a: mk(), b: mk() };
}

describe('共享缓存', () => {
  it('一个实例算出来的结果，另一个实例直接命中（榜单不再各说各话）', () => {
    const { a, b } = twoInstances();
    let calls = 0;
    const compute = () => {
      calls++;
      return { board: 'novels', items: [{ id: 'n1', rank: 1 }] };
    };
    expect(getCached(a, 'leaderboard:novels:week', 2 * MINUTE, compute)).toEqual(compute());
    calls = 0;
    expect(getCached(b, 'leaderboard:novels:week', 2 * MINUTE, compute).items[0]!.id).toBe('n1');
    expect(calls).toBe(0);
  });

  it('TTL 到期后重算', () => {
    const { a, clock } = twoInstances();
    let calls = 0;
    const compute = () => {
      calls++;
      return calls;
    };
    expect(getCached(a, 'k', MINUTE, compute)).toBe(1);
    clock.advance(MINUTE - 1);
    expect(getCached(a, 'k', MINUTE, compute)).toBe(1);
    clock.advance(2);
    expect(getCached(a, 'k', MINUTE, compute)).toBe(2);
  });

  it('内容坏掉时当作未命中重算，不抛错', () => {
    const { a, db } = twoInstances();
    putCache(a, 'k', { ok: true }, MINUTE);
    db.update(cacheEntries).set({ value: '{ 这不是 JSON' }).run();
    expect(getCached(a, 'k', MINUTE, () => ({ ok: false }))).toEqual({ ok: false });
  });

  it('按前缀失效 + 过期清理', () => {
    const { a, clock } = twoInstances();
    putCache(a, 'leaderboard:novels:week', 1, MINUTE);
    putCache(a, 'leaderboard:authors:week', 2, MINUTE);
    putCache(a, 'other:x', 3, MINUTE);
    expect(invalidateCache(a, 'leaderboard:')).toBe(2);
    expect(a.db.select().from(cacheEntries).all().length).toBe(1);

    clock.advance(2 * MINUTE);
    expect(gcCache(a)).toBe(1);
    expect(a.db.select().from(cacheEntries).all().length).toBe(0);
  });
});
