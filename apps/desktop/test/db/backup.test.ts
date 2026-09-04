import { afterAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_SCHEMA_VERSION, backupFileName, checkBackup, hasTable, isSqliteBytes, preRestoreCopyName, readUserVersion } from '@/db/backup';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../src-tauri/migrations/', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'water-backup-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** 造一个真实的库文件：跑完所有迁移，再盖上给定的数据版本号。 */
function makeDbBytes(name: string, userVersion: number | null, sql?: string): Uint8Array {
  const path = join(dir, name);
  const db = new DatabaseSync(path);
  if (sql) db.exec(sql);
  else for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(readFileSync(MIGRATIONS_DIR + f, 'utf8').replace(/PRAGMA journal_mode = WAL;/, ''));
  }
  if (userVersion !== null) db.exec(`PRAGMA user_version = ${userVersion};`);
  db.close();
  return new Uint8Array(readFileSync(path));
}

describe('SQLite 文件识别', () => {
  it('认得出 SQLite 头与 user_version', () => {
    const bytes = makeDbBytes('good.db', APP_SCHEMA_VERSION);
    expect(isSqliteBytes(bytes)).toBe(true);
    expect(readUserVersion(bytes)).toBe(APP_SCHEMA_VERSION);
    expect(hasTable(bytes, 'novels')).toBe(true);
    expect(hasTable(bytes, 'documents')).toBe(true);
    expect(hasTable(bytes, 'chapters')).toBe(true);
  });
  it('随便一段字节不是 SQLite', () => {
    expect(isSqliteBytes(new TextEncoder().encode('不是数据库'))).toBe(false);
    expect(isSqliteBytes(new Uint8Array(200))).toBe(false);
    expect(readUserVersion(new Uint8Array(4))).toBe(0);
  });
});

describe('备份校验', () => {
  it('接受当前版本的备份', () => {
    const r = checkBackup(makeDbBytes('cur.db', APP_SCHEMA_VERSION));
    expect(r.ok).toBe(true);
    expect(r.version).toBe(APP_SCHEMA_VERSION);
    expect(r.needsMigration).toBe(false);
  });

  it('接受更老的备份，并标记需要补迁移', () => {
    const r = checkBackup(makeDbBytes('old.db', 3));
    expect(r.ok).toBe(true);
    expect(r.needsMigration).toBe(true);
  });

  it('没盖版本号的老备份（user_version = 0）也收', () => {
    const r = checkBackup(makeDbBytes('nov.db', null));
    expect(r.ok).toBe(true);
    expect(r.version).toBe(0);
    expect(r.needsMigration).toBe(true);
  });

  it('拒绝来自更新版本的备份', () => {
    const r = checkBackup(makeDbBytes('new.db', APP_SCHEMA_VERSION + 1));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('更新版本');
  });

  it('拒绝非 SQLite 文件', () => {
    const r = checkBackup(new TextEncoder().encode('hello'));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('不是 SQLite');
  });

  it('拒绝别的应用的 SQLite 库', () => {
    const r = checkBackup(makeDbBytes('other.db', 1, 'CREATE TABLE IF NOT EXISTS whatever (id TEXT);'));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('不像是 The Water 的备份');
  });
});

describe('备份文件名', () => {
  it('按时间命名，扩展名是 .db', () => {
    expect(backupFileName(new Date(2026, 8, 4, 15, 30))).toBe('the-water-backup-20260904-1530.db');
    expect(preRestoreCopyName(new Date(1000))).toBe('the-water.db.before-restore-1000');
  });
});
