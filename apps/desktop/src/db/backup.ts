import { getDb } from './db';

/** 数据库文件在 appdata 下的相对路径。 */
export const DB_FILE = 'the-water.db';
/**
 * 当前应用的数据版本 = 最新一条迁移的 version（`src-tauri/src/lib.rs` 与 `src-tauri/migrations/`）。
 * 加迁移时必须同步改这里，否则备份会被盖上过时的版本号，
 * 而「备份来自更新版本的 The Water」这道保护就形同虚设。
 * `test/db/backup.test.ts` 会读迁移目录断言两者一致，漏改即测试红。
 */
export const APP_SCHEMA_VERSION = 8;

const SQLITE_MAGIC = 'SQLite format 3\0';
/** 备份必须能找到的表，避免把别的 SQLite 文件当成本应用的库恢复进来。 */
const REQUIRED_TABLES = ['novels', 'documents', 'chapters'];

export function isSqliteBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 100) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i += 1) if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  return true;
}

/** SQLite 头部第 60 字节起的 4 字节大端整数就是 user_version，备份时我们往里写数据版本。 */
export function readUserVersion(bytes: Uint8Array): number {
  if (bytes.length < 64) return 0;
  return ((bytes[60]! << 24) | (bytes[61]! << 16) | (bytes[62]! << 8) | bytes[63]!) >>> 0;
}

/** 表定义原样存在 sqlite_master 里，直接在字节里找就能判断是不是本应用的库。 */
export function hasTable(bytes: Uint8Array, table: string): boolean {
  const needle = `CREATE TABLE ${table}`;
  const codes = Array.from(needle, (c) => c.charCodeAt(0));
  outer: for (let i = 0; i + codes.length <= bytes.length; i += 1) {
    for (let j = 0; j < codes.length; j += 1) if (bytes[i + j] !== codes[j]) continue outer;
    return true;
  }
  return false;
}

export interface BackupCheck {
  ok: boolean;
  /** 备份里记录的数据版本；老备份或外部工具产生的文件是 0。 */
  version: number;
  reason?: string;
  /** 版本比当前应用旧，恢复后启动时会自动补迁移。 */
  needsMigration: boolean;
}

/** 恢复前的校验：得是 SQLite、得是本应用的库、版本不能比当前应用还新。 */
export function checkBackup(bytes: Uint8Array, appVersion: number = APP_SCHEMA_VERSION): BackupCheck {
  if (!isSqliteBytes(bytes)) return { ok: false, version: 0, needsMigration: false, reason: '这个文件不是 SQLite 数据库，换一个备份试试。' };
  const missing = REQUIRED_TABLES.filter((t) => !hasTable(bytes, t));
  if (missing.length > 0) return { ok: false, version: 0, needsMigration: false, reason: `这个数据库里没有 ${missing.join('、')} 表，不像是 The Water 的备份。` };
  const version = readUserVersion(bytes);
  if (version > appVersion) {
    return { ok: false, version, needsMigration: false, reason: `备份来自更新版本的 The Water（数据版本 ${version}，当前 ${appVersion}），请先升级应用再恢复。` };
  }
  return { ok: true, version, needsMigration: version < appVersion };
}

/** 备份文件名：the-water-backup-20260904-1530.db */
export function backupFileName(at: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `the-water-backup-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}.db`;
}
/** 恢复前给现有库留的保险副本，放在 appdata 下。 */
export function preRestoreCopyName(at: Date = new Date()): string {
  return `${DB_FILE}.before-restore-${at.getTime()}`;
}

/**
 * 把当前库落盘成一个可搬走的单文件：先把 WAL 合并回主库，再盖上数据版本号。
 * 失败不抛（PRAGMA 在某些环境下不可用），只是备份里少个版本号。
 */
async function sealDatabase(): Promise<void> {
  const db = getDb();
  await db.execute(`PRAGMA user_version = ${APP_SCHEMA_VERSION}`).catch(() => undefined);
  await db.execute('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => undefined);
}

/** 备份数据库：弹保存对话框，把主库文件复制过去。返回路径，取消则 null。 */
export async function backupDatabase(): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const { BaseDirectory, copyFile } = await import('@tauri-apps/plugin-fs');
  await sealDatabase();
  const path = await save({ defaultPath: backupFileName(), filters: [{ name: '数据库备份', extensions: ['db'] }] });
  if (!path) return null;
  await copyFile(DB_FILE, path, { fromPathBaseDir: BaseDirectory.AppData });
  return path;
}

export interface RestoreResult {
  path: string;
  version: number;
  /** 恢复前现有库的保险副本（appdata 下的相对路径）。 */
  previousCopy: string;
  /** 恢复后必须重启：进程里的连接指向的已经是旧文件了。 */
  needsRestart: true;
}

/**
 * 从备份恢复：校验 → 现有库另存一份 → 关闭连接 → 覆盖主库 → 清掉 WAL/SHM。
 * 恢复完必须重启应用。
 */
export async function restoreDatabase(path?: string): Promise<RestoreResult | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const { BaseDirectory, copyFile, readFile, remove, writeFile } = await import('@tauri-apps/plugin-fs');
  const picked = path ?? (await open({ multiple: false, filters: [{ name: '数据库备份', extensions: ['db', 'sqlite', 'sqlite3'] }] }));
  if (!picked || Array.isArray(picked)) return null;

  const bytes = await readFile(picked);
  const check = checkBackup(bytes);
  if (!check.ok) throw new Error(check.reason ?? '备份文件无法识别');

  const previousCopy = preRestoreCopyName();
  await copyFile(DB_FILE, previousCopy, { fromPathBaseDir: BaseDirectory.AppData, toPathBaseDir: BaseDirectory.AppData }).catch(() => undefined);
  await closeConnection();
  await writeFile(DB_FILE, bytes, { baseDir: BaseDirectory.AppData });
  // WAL / SHM 属于旧库，留着会和新文件对不上
  for (const stale of [`${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    await remove(stale, { baseDir: BaseDirectory.AppData }).catch(() => undefined);
  }
  return { path: picked, version: check.version, previousCopy, needsRestart: true };
}

async function closeConnection(): Promise<void> {
  try {
    const { default: Database } = await import('@tauri-apps/plugin-sql');
    const { DB_URL } = await import('./tauriDb');
    const inner = await Database.load(DB_URL);
    await inner.close();
  } catch {
    /* 关不掉也继续：文件覆盖后立刻重启即可 */
  }
}

/** 在系统文件管理器里打开数据目录（选中数据库文件）。 */
export async function openDataDir(): Promise<string> {
  const { appDataDir, join } = await import('@tauri-apps/api/path');
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
  const dir = await appDataDir();
  await revealItemInDir(await join(dir, DB_FILE));
  return dir;
}
