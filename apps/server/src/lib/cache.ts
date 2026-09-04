/**
 * 跨实例共享的小缓存（§4.5）。
 *
 * 进程内 Map 做缓存在多实例下会让不同用户看到不同的榜单，而且实例越多缓存命中率越低。
 * 落到 `cache_entries` 表后，所有实例共用同一份快照，谁先算出来谁写进去。
 *
 * 只适合「算一次贵、结果小、可容忍 TTL 内陈旧」的东西（榜单、统计卡片）。
 * 值走 JSON 序列化，因此存进去的必须是纯数据：Date 会变成字符串，Map / Set 会丢。
 */
import { eq, lt, sql } from 'drizzle-orm';
import { changes } from '../db/client';
import { cacheEntries } from '../db/schema';
import type { AppDeps } from '../context';

type CacheDeps = Pick<AppDeps, 'db' | 'clock'>;

/** 读缓存；未命中或已过期则调用 compute 重算并写回。 */
export function getCached<T>(deps: CacheDeps, key: string, ttlMs: number, compute: () => T): T {
  const now = deps.clock.now().getTime();
  const hit = deps.db
    .select({ value: cacheEntries.value, expiresAt: cacheEntries.expiresAt })
    .from(cacheEntries)
    .where(eq(cacheEntries.key, key))
    .get();
  if (hit && hit.expiresAt > now) {
    try {
      return JSON.parse(hit.value) as T;
    } catch {
      // 缓存内容坏了（手工改过 / 旧版本格式）就当未命中重算。
    }
  }
  const value = compute();
  putCache(deps, key, value, ttlMs);
  return value;
}

/** 直接写入一条缓存。 */
export function putCache(deps: CacheDeps, key: string, value: unknown, ttlMs: number): void {
  const now = deps.clock.now();
  deps.db
    .insert(cacheEntries)
    .values({ key, value: JSON.stringify(value), expiresAt: now.getTime() + ttlMs, updatedAt: now })
    .onConflictDoUpdate({
      target: cacheEntries.key,
      set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at`, updatedAt: sql`excluded.updated_at` },
    })
    .run();
}

/** 失效：给定前缀则按前缀删，否则清空。返回删除行数。 */
export function invalidateCache(deps: CacheDeps, prefix?: string): number {
  const q = deps.db.delete(cacheEntries);
  if (prefix === undefined) return changes(q.run());
  return changes(q.where(sql`${cacheEntries.key} LIKE ${`${prefix}%`} ESCAPE '\\'`).run());
}

/** 清理过期条目；挂在每小时 GC 上。返回删除行数。 */
export function gcCache(deps: CacheDeps): number {
  return changes(deps.db.delete(cacheEntries).where(lt(cacheEntries.expiresAt, deps.clock.now().getTime())).run());
}
