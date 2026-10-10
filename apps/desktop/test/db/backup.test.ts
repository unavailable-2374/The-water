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

describe('数据版本不漂移', () => {
  it('APP_SCHEMA_VERSION 等于迁移目录里最大的迁移号', () => {
    const dir = fileURLToPath(new URL('../../src-tauri/migrations/', import.meta.url));
    const nums = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => Number(f.slice(0, 4)))
      .filter((n) => Number.isFinite(n));
    expect(nums.length).toBeGreaterThan(0);
    // 漏改这个常量，备份会被盖上过时版本号，恢复时的「来自更新版本」保护就失效了。
    expect(APP_SCHEMA_VERSION).toBe(Math.max(...nums));
  });
});

it('TEST consistent V9 snapshot restores candidates, committed pointers and provenance',async()=>{
  const {mkdirSync}=await import('node:fs');const {homedir}=await import('node:os');
  const base=join(homedir(),'.codex','validation');mkdirSync(base,{recursive:true});
  const target=mkdtempSync(join(base,'TEST-workbench-backup-'));
  const {useTestDb}=await import('../helpers/testDb');const db=useTestDb();
  const {snapshotDatabase}=await import('@/db/backup');
  const {createNovel}=await import('@/db/repos/novelsRepo');const {defaultRequirements}=await import('@/novel/types');
  const {upsertChapterPlan,createVersion}=await import('@/db/repos/chaptersRepo');
  const {stageTestChapter}=await import('../helpers/writing');const {commitPreparedChapter}=await import('@/db/repos/writingRepo');
  try {
    const n=await createNovel({title:'TEST snapshot',premise:'TEST',requirements:defaultRequirements(),targetChars:3000});
    const c=await upsertChapterPlan(n.id,{chapterNo:1});const official=await createVersion({chapterId:c.id,source:'generated',content:'TEST committed source'});
    await stageTestChapter(c.id);await commitPreparedChapter(c.id,official.id);
    const candidate=await createVersion({chapterId:c.id,source:'user_edit',content:'TEST pending text'});
    const path=join(target,'TEST-backup.db');await snapshotDatabase(path);
    const restored=new DatabaseSync(path);
    try {expect(restored.prepare('PRAGMA integrity_check').get()).toMatchObject({integrity_check:'ok'});expect(restored.prepare('PRAGMA foreign_key_check').all()).toEqual([]);expect(restored.prepare('SELECT current_version_id,committed_version_id FROM chapters').get()).toMatchObject({current_version_id:candidate.id,committed_version_id:official.id});expect(restored.prepare('SELECT content_hash,review_id FROM chapter_commits').get()).toMatchObject({content_hash:official.contentHash});expect(checkBackup(readFileSync(path)).ok).toBe(true);} finally {restored.close();}
  } finally {db.raw.close();rmSync(target,{recursive:true,force:true});}
});
