/**
 * 0004 迁移对**已有数据**的兼容性。
 *
 * 做法：把 drizzle 目录复制到临时目录、摘掉 0004，先建出一个「只到 0003 的老库」并塞进真实数据，
 * 再用仓库里完整的迁移集重放，确认新表 / 触发器 / 回填全部落地且可重复执行。
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { novels, users } from '../src/db/schema';

const DRIZZLE = join(import.meta.dir, '..', 'drizzle');
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** 复制一份迁移目录并砍掉 idx >= keepBefore 的条目，用来伪造「老版本的仓库」。 */
function migrationsUpTo(keepBefore: number): string {
  const dir = join(temp('the-water-drizzle-'), 'drizzle');
  cpSync(DRIZZLE, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx < keepBefore);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return dir;
}

describe('0004 迁移在非空老库上的重放', () => {
  it('新增表 / 触发器 / 回填都能落地，且可重复执行', () => {
    const dbPath = join(temp('the-water-oldlib-'), 'old.sqlite');

    // 1) 造一个只到 0003 的老库，塞进一个用户和一本作品。
    {
      const { db } = createDb(dbPath);
      migrate(db, { migrationsFolder: migrationsUpTo(4) });
      const now = new Date();
      db.insert(users)
        .values({ id: 'u1', email: 'a@example.com', passwordHash: 'x', handle: 'u_a', displayName: '甲', createdAt: now, updatedAt: now })
        .run();
      db.insert(novels)
        .values({
          id: 'n1',
          authorId: 'u1',
          title: '灯下长街',
          summary: '雪夜守灯人的故事。',
          tags: [],
          license: 'cc-by-sa',
          rootNovelId: 'n1',
          createdAt: now,
          updatedAt: now,
        })
        .run();
      expect(db.select().from(novels).all().length).toBe(1);
      // 老库里当然还没有这些东西。
      expect(() => db.all(sql`SELECT 1 FROM novels_fts_pending`)).toThrow();
    }

    // 2) 用完整迁移集重放。
    {
      const { db } = createDb(dbPath);
      runMigrations(db);
      // 老数据还在。
      expect(db.select().from(users).all().length).toBe(1);
      // 回填 + 排空之后，老作品已经进了索引。
      const pending = db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM novels_fts_pending`);
      expect(Number(pending[0]!.n)).toBe(0);
      const hit = db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM novels_fts WHERE body MATCH '"长街"'`);
      expect(Number(hit[0]!.n)).toBe(1);
      // 触发器已挂上：改标题会重新排队。
      db.run(sql`UPDATE novels SET title = '新标题' WHERE id = 'n1'`);
      const requeued = db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM novels_fts_pending`);
      expect(Number(requeued[0]!.n)).toBe(1);

      // 3) 再重放一次，幂等。
      runMigrations(db);
      expect(db.select().from(users).all().length).toBe(1);
    }
  });
});
