import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  backupFileName,
  createBackup,
  listBackups,
  parseBackupTime,
  planRetention,
  pruneBackups,
  verifyDatabaseFile,
} from '../scripts/backup';
import { parseRestoreArgs, restoreBackup, verifyBackup } from '../scripts/restore';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { users } from '../src/db/schema';

const dirs: string[] = [];

function workDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'the-water-backup-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** 建一个跑过迁移、带一行用户数据的真实库。 */
function seedDb(path: string, handle: string): void {
  const { db, sqlite } = createDb(path);
  runMigrations(db);
  const now = new Date('2026-09-01T00:00:00.000Z');
  db.insert(users)
    .values({
      id: 'u-1',
      email: `${handle}@example.com`,
      passwordHash: 'x',
      handle,
      displayName: '甲',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  sqlite.close();
}

/**
 * 读出一个库里的 handle 列表。先整组复制到新路径再打开：
 * 测试进程里 drizzle 的连接不会真正释放，SQLite 拒绝打开“仍被本进程打开、
 * 但期间已改名”的同一 inode（disk I/O error）。恢复脚本在独立进程里跑没有这个问题。
 */
function readHandles(path: string): string[] {
  const probe = `${path}.probe-${Math.random().toString(36).slice(2)}`;
  copyFileSync(path, probe);
  for (const side of ['-wal', '-shm']) {
    if (existsSync(`${path}${side}`)) copyFileSync(`${path}${side}`, `${probe}${side}`);
  }
  const db = new Database(probe);
  try {
    return (db.query('SELECT handle FROM users ORDER BY handle').all() as Array<{ handle: string }>).map((r) => r.handle);
  } finally {
    db.close();
  }
}

describe('备份脚本', () => {
  it('VACUUM INTO 产出可用备份，且新库能读到源库数据', () => {
    const dir = workDir();
    const dbPath = join(dir, 'data', 'dev.sqlite');
    seedDb(dbPath, 'jia');

    const r = createBackup({ databaseUrl: dbPath, backupDir: join(dir, 'backups'), now: new Date('2026-09-04T03:00:00.000Z') });
    expect(r.path.endsWith('the-water-20260904-030000.sqlite')).toBe(true);
    expect(r.byteSize).toBeGreaterThan(0);
    expect(r.removed).toEqual([]);

    // 备份是独立单文件：没有 WAL 尾巴也能读全数据。
    expect(existsSync(`${r.path}-wal`)).toBe(false);
    expect(readHandles(r.path)).toEqual(['jia']);
    expect(() => verifyDatabaseFile(r.path)).not.toThrow();
  });

  it('源库不存在或同名备份重复时给出明确错误 / 自动避让', () => {
    const dir = workDir();
    expect(() => createBackup({ databaseUrl: join(dir, 'missing.sqlite'), backupDir: dir })).toThrow(/源数据库不存在/);

    const dbPath = join(dir, 'dev.sqlite');
    seedDb(dbPath, 'yi');
    const at = new Date('2026-09-04T03:00:00.000Z');
    const backupDir = join(dir, 'backups');
    const a = createBackup({ databaseUrl: dbPath, backupDir, now: at, prune: false });
    const b = createBackup({ databaseUrl: dbPath, backupDir, now: at, prune: false });
    expect(b.path).not.toBe(a.path);
    expect(listBackups(backupDir).length).toBe(2);
  });

  it('文件名可往返解析，非备份文件被忽略', () => {
    const at = new Date('2026-01-02T03:04:05.000Z');
    expect(backupFileName(at)).toBe('the-water-20260102-030405.sqlite');
    expect(parseBackupTime(backupFileName(at))?.toISOString()).toBe(at.toISOString());
    expect(parseBackupTime('README.md')).toBeNull();
    expect(parseBackupTime('the-water-2026.sqlite')).toBeNull();
  });
});

describe('GFS 保留策略（7 日 / 4 周 / 12 月）', () => {
  /** 从 2026-09-04 起往回每天一个备份，共 400 天。 */
  const daily = (days: number, end = Date.UTC(2026, 8, 4, 3, 0, 0)) =>
    Array.from({ length: days }, (_, i) => {
      const at = new Date(end - i * 86_400_000);
      return { name: backupFileName(at), at };
    });

  it('每天一个备份跑满一年时，只留下 7 日 + 4 周 + 12 月的代表', () => {
    const { keep, drop } = planRetention(daily(400));
    expect(keep.length + drop.length).toBe(400);
    // 最新的一份永远保留。
    expect(keep[0]!.name).toBe(daily(1)[0]!.name);
    // 最近 7 天全在。
    for (const e of daily(7)) expect(keep.some((k) => k.name === e.name)).toBe(true);
    // 上限：7 + 4 + 12 = 23，去重后不会更多。
    expect(keep.length).toBeLessThanOrEqual(23);
    expect(keep.length).toBeGreaterThanOrEqual(19);
    // 一年前的备份必被淘汰。
    expect(drop.some((d) => d.at.getTime() < Date.UTC(2025, 8, 10))).toBe(true);
  });

  it('同一天多次备份只留当天最新的一份', () => {
    const entries = [
      new Date('2026-09-04T09:00:00Z'),
      new Date('2026-09-04T03:00:00Z'),
      new Date('2026-09-03T03:00:00Z'),
    ].map((at) => ({ name: backupFileName(at), at }));
    const { keep, drop } = planRetention(entries);
    expect(keep.map((k) => k.name)).toContain(backupFileName(new Date('2026-09-04T09:00:00Z')));
    expect(drop.map((d) => d.name)).toEqual([backupFileName(new Date('2026-09-04T03:00:00Z'))]);
  });

  it('备份数量不足保留额度时一个都不删', () => {
    const { keep, drop } = planRetention(daily(3));
    expect(keep.length).toBe(3);
    expect(drop.length).toBe(0);
  });

  it('pruneBackups 真的删文件，且不碰非备份文件', () => {
    const dir = workDir();
    for (const e of daily(30)) writeFileSync(join(dir, e.name), 'x');
    writeFileSync(join(dir, 'NOTES.txt'), '手写笔记');

    const removed = pruneBackups(dir);
    expect(removed.length).toBeGreaterThan(0);
    for (const name of removed) expect(existsSync(join(dir, name))).toBe(false);
    expect(existsSync(join(dir, 'NOTES.txt'))).toBe(true);
    expect(readdirSync(dir).length).toBe(30 - removed.length + 1);
  });

  it('createBackup 默认在备份后执行轮转', () => {
    const dir = workDir();
    const dbPath = join(dir, 'dev.sqlite');
    seedDb(dbPath, 'bing');
    const backupDir = join(dir, 'backups');
    mkdirSync(backupDir, { recursive: true });
    for (const e of daily(40, Date.UTC(2026, 8, 3, 3, 0, 0))) writeFileSync(join(backupDir, e.name), 'x');

    const r = createBackup({ databaseUrl: dbPath, backupDir, now: new Date('2026-09-04T03:00:00Z') });
    expect(r.removed.length).toBeGreaterThan(0);
    expect(existsSync(r.path)).toBe(true);
    expect(listBackups(backupDir).some((b) => join(backupDir, b.name) === r.path)).toBe(true);
  });
});

describe('恢复脚本', () => {
  it('恢复到新路径后数据可读，并通过完整性校验', () => {
    const dir = workDir();
    const dbPath = join(dir, 'dev.sqlite');
    seedDb(dbPath, 'ding');
    const { path: backup } = createBackup({ databaseUrl: dbPath, backupDir: join(dir, 'backups') });

    const target = join(dir, 'restored', 'app.sqlite');
    const r = restoreBackup({ backupPath: backup, targetPath: target });
    expect(r.previousPath).toBeNull();
    expect(r.tableCount).toBeGreaterThan(5);
    expect(r.fkIssues).toBe(0);

    // 恢复出来的库可以直接被服务使用：迁移已是最新，数据完好。
    const { db, sqlite } = createDb(target);
    runMigrations(db);
    expect(db.select().from(users).where(eq(users.handle, 'ding')).get()?.displayName).toBe('甲');
    sqlite.close();
  });

  it('目标已存在时必须 --force，覆盖前把旧库另存', () => {
    const dir = workDir();
    const oldDb = join(dir, 'app.sqlite');
    seedDb(oldDb, 'old');
    const srcDb = join(dir, 'src.sqlite');
    seedDb(srcDb, 'new');
    const { path: backup } = createBackup({ databaseUrl: srcDb, backupDir: join(dir, 'backups') });

    expect(() => restoreBackup({ backupPath: backup, targetPath: oldDb })).toThrow(/--force/);

    const r = restoreBackup({ backupPath: backup, targetPath: oldDb, force: true, now: new Date('2026-09-04T03:00:00Z') });
    expect(r.previousPath).toBe(`${oldDb}.pre-restore-20260904-030000`);
    expect(existsSync(r.previousPath!)).toBe(true);

    expect(readHandles(oldDb)).toEqual(['new']);
    // 旧库连同 WAL 一起被搬走，数据完好，可回退。
    expect(readHandles(r.previousPath!)).toEqual(['old']);
  });

  it('拒绝损坏文件、非本服务的库与不存在的文件，且失败时不动目标库', () => {
    const dir = workDir();
    expect(() => verifyBackup(join(dir, 'nope.sqlite'))).toThrow(/不存在/);

    const broken = join(dir, 'broken.sqlite');
    writeFileSync(broken, 'this is not a sqlite file at all');
    expect(() => verifyBackup(broken)).toThrow();

    const foreign = join(dir, 'foreign.sqlite');
    const f = new Database(foreign, { create: true });
    f.exec('CREATE TABLE notes(a TEXT)');
    f.close();
    expect(() => verifyBackup(foreign)).toThrow(/缺少关键表/);

    const target = join(dir, 'app.sqlite');
    seedDb(target, 'keep');
    expect(() => restoreBackup({ backupPath: foreign, targetPath: target, force: true })).toThrow(/缺少关键表/);
    expect(readHandles(target)).toEqual(['keep']);
  });

  it('命令行参数解析：位置参数 / --to / --force', () => {
    expect(parseRestoreArgs(['b.sqlite'])).toEqual({ backupPath: 'b.sqlite', to: undefined, force: false });
    expect(parseRestoreArgs(['--to', 'x.sqlite', 'b.sqlite', '--force'])).toEqual({
      backupPath: 'b.sqlite',
      to: 'x.sqlite',
      force: true,
    });
    expect(parseRestoreArgs([]).backupPath).toBeUndefined();
  });
});
