/**
 * §4.5：启动自动迁移加锁。
 * 滚动部署时两个实例会同时启动、同时跑迁移；从前谁都不等谁。
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '../src/db/client';
import { MigrationLockTimeout, runMigrations, withMigrationLock } from '../src/db/migrate';
import { novels, users } from '../src/db/schema';

const dirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'the-water-migrate-'));
  dirs.push(dir);
  return join(dir, 'test.sqlite');
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('迁移锁', () => {
  it('持锁期间另一个实例拿不到锁，释放后立刻能拿到', () => {
    const path = tempDbPath();
    const { db: a } = createDb(path);
    const { db: b } = createDb(path);

    let blocked = false;
    withMigrationLock(a, () => {
      expect(() => withMigrationLock(b, () => undefined, { timeoutMs: 150, pollMs: 20 })).toThrow(MigrationLockTimeout);
      blocked = true;
    });
    expect(blocked).toBe(true);

    // A 释放之后 B 立刻能进。
    let ran = false;
    withMigrationLock(b, () => {
      ran = true;
    }, { timeoutMs: 500, pollMs: 20 });
    expect(ran).toBe(true);
  });

  it('抛错也会释放锁，锁行不会被留下', () => {
    const path = tempDbPath();
    const { db } = createDb(path);
    expect(() =>
      withMigrationLock(db, () => {
        throw new Error('迁移炸了');
      }),
    ).toThrow('迁移炸了');
    const rows = db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM schema_lock`);
    expect(Number(rows[0]!.n)).toBe(0);
    // 锁没被卡住，还能再拿。
    withMigrationLock(db, () => undefined, { timeoutMs: 200 });
  });

  it('持有者崩溃留下的陈旧锁会被强抢', () => {
    const path = tempDbPath();
    const { db } = createDb(path);
    db.run(sql.raw('CREATE TABLE IF NOT EXISTS schema_lock (id INTEGER PRIMARY KEY CHECK (id = 1), holder TEXT NOT NULL, acquired_at INTEGER NOT NULL)'));
    db.run(sql`INSERT INTO schema_lock (id, holder, acquired_at) VALUES (1, 'dead-instance', 0)`);
    let ran = false;
    withMigrationLock(db, () => {
      ran = true;
    }, { timeoutMs: 300, staleMs: 1_000, now: () => 10_000 });
    expect(ran).toBe(true);
  });

  it('两个实例先后跑迁移，结果一致且可重复（老库上重放不报错）', async () => {
    const path = tempDbPath();
    const { db: a } = createDb(path);
    const { db: b } = createDb(path);
    runMigrations(a);
    // 写一行真实数据，验证第二次迁移在非空库上照样能跑完。
    const now = new Date();
    a.insert(users)
      .values({
        id: 'u1',
        email: 'a@example.com',
        passwordHash: 'x',
        handle: 'u_a',
        displayName: '甲',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    runMigrations(b);
    runMigrations(a);
    expect(a.select().from(users).all().length).toBe(1);
    expect(b.select().from(novels).all().length).toBe(0);
  });
});
