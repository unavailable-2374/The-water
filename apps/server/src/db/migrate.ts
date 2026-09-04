import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { join } from 'node:path';
import type { Db } from './client';
import { ensureFtsSchema, syncNovelsFts } from './fts';

const MIGRATIONS_FOLDER = join(import.meta.dir, '..', '..', 'drizzle');

/**
 * 迁移锁：滚动部署时两个实例会同时启动并同时跑迁移，drizzle 的 migrator 本身不加锁，
 * 两边可能同时执行同一批 DDL。这里用一张单行表当互斥量：
 * 用 `BEGIN IMMEDIATE` 抢到写锁再读写锁行，保证「检查 + 占位」是原子的。
 *
 * 这张表不进 drizzle schema：它必须在第一次迁移之前就存在，
 * 让 drizzle 去建就成了先有鸡还是先有蛋。
 */
const CREATE_LOCK = `CREATE TABLE IF NOT EXISTS schema_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder TEXT NOT NULL,
  acquired_at INTEGER NOT NULL
)`;

export interface LockOptions {
  /** 等不到锁多久放弃（毫秒）。 */
  timeoutMs?: number;
  /** 锁持有超过这么久视为持有者已崩溃，可以强抢（毫秒）。 */
  staleMs?: number;
  /** 持有者标识，默认进程 pid + 随机串。 */
  holder?: string;
  /** 轮询间隔（毫秒）。 */
  pollMs?: number;
  /** 当前时间，测试可注入。 */
  now?: () => number;
}

export class MigrationLockTimeout extends Error {
  constructor(holder: string) {
    super(`迁移锁被 ${holder} 占用，等待超时；另一个实例可能正在迁移`);
    this.name = 'MigrationLockTimeout';
  }
}

/** 抢锁 → 执行 → 释放。抢不到抛 MigrationLockTimeout。 */
export function withMigrationLock<T>(db: Db, fn: () => T, opts: LockOptions = {}): T {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const staleMs = opts.staleMs ?? 120_000;
  const pollMs = opts.pollMs ?? 100;
  const now = opts.now ?? (() => Date.now());
  const holder = opts.holder ?? `pid:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;

  db.run(sql.raw(CREATE_LOCK));

  const deadline = now() + timeoutMs;
  let blockedBy = '未知实例';
  for (;;) {
    if (tryAcquire(db, holder, staleMs, now)) break;
    blockedBy = currentHolder(db) ?? blockedBy;
    if (now() >= deadline) throw new MigrationLockTimeout(blockedBy);
    Bun.sleepSync(pollMs);
  }

  try {
    return fn();
  } finally {
    try {
      db.run(sql`DELETE FROM schema_lock WHERE id = 1 AND holder = ${holder}`);
    } catch {
      /* 释放失败也不该盖住 fn 抛出的原始错误；staleMs 之后会被下一个实例强抢 */
    }
  }
}

function currentHolder(db: Db): string | null {
  try {
    const rows = db.all<{ holder: string }>(sql`SELECT holder FROM schema_lock WHERE id = 1`);
    return rows[0]?.holder ?? null;
  } catch {
    return null;
  }
}

function tryAcquire(db: Db, holder: string, staleMs: number, now: () => number): boolean {
  try {
    db.run(sql.raw('BEGIN IMMEDIATE'));
  } catch {
    // 另一个实例正握着 SQLite 的写锁（busy_timeout 之后仍未释放），下一轮再试。
    return false;
  }
  try {
    const rows = db.all<{ holder: string; acquired_at: number }>(sql`SELECT holder, acquired_at FROM schema_lock WHERE id = 1`);
    const held = rows[0];
    const t = now();
    if (held && t - Number(held.acquired_at) < staleMs) {
      db.run(sql.raw('ROLLBACK'));
      return false;
    }
    db.run(sql`
      INSERT INTO schema_lock (id, holder, acquired_at) VALUES (1, ${holder}, ${t})
      ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, acquired_at = excluded.acquired_at
    `);
    db.run(sql.raw('COMMIT'));
    return true;
  } catch (e) {
    try {
      db.run(sql.raw('ROLLBACK'));
    } catch {
      /* 事务可能已经自动回滚 */
    }
    throw e;
  }
}

/**
 * 跑迁移。全程持锁，迁移完成后建 FTS 虚拟表并排空重建队列
 * （0004 迁移把已有作品全部排进了队列，这一步就是老库的索引回填）。
 */
export function runMigrations(db: Db, opts: LockOptions = {}): void {
  withMigrationLock(
    db,
    () => {
      migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      if (ensureFtsSchema(db)) syncNovelsFts(db, Number.MAX_SAFE_INTEGER);
    },
    opts,
  );
}

if (import.meta.main) {
  const { loadEnv } = await import('../env');
  const { createDb } = await import('./client');
  const env = loadEnv();
  const { db } = createDb(env.databaseUrl);
  runMigrations(db);
  console.log(`迁移完成：${env.databaseUrl}`);
}
