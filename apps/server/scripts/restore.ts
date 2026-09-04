/**
 * 从备份文件恢复数据库。
 *
 * 流程：校验备份完整性（`PRAGMA integrity_check` + 关键表存在）→ 把现有库另存为
 * `<db>.pre-restore-<时间戳>` → 复制备份就位 → 再次校验恢复后的库。
 * 目标库已存在时必须显式 `--force`，避免误覆盖线上数据。
 *
 * 用法：
 *   bun run db:restore ./data/backups/the-water-20260904-030000.sqlite --force
 *   bun run db:restore <备份文件> --to ./data/restored.sqlite   # 恢复到别处先验证
 */
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { verifyDatabaseFile } from './backup';

/** 恢复后必须存在的关键表，防止把一个空库 / 无关的 sqlite 文件当成备份。 */
const REQUIRED_TABLES = ['users', 'novels', 'novel_versions', 'blobs', 'version_chapters'];

export interface RestoreOptions {
  backupPath: string;
  targetPath: string;
  /** 目标库已存在时必须为 true 才会覆盖。 */
  force?: boolean;
  now?: Date;
}

export interface RestoreResult {
  backupPath: string;
  targetPath: string;
  /** 被覆盖的旧库另存位置；目标原本不存在时为 null。 */
  previousPath: string | null;
  tableCount: number;
  /** 备份内的外键异常条数；> 0 说明源库本身就有脏数据，恢复照做但要人工确认。 */
  fkIssues: number;
}

/** 校验一个 sqlite 文件确实是本服务的可用备份。外键异常只作为告警返回，不阻断恢复。 */
export function verifyBackup(path: string): { tableCount: number; fkIssues: number } {
  if (!existsSync(path)) throw new Error(`备份文件不存在：${path}`);
  verifyDatabaseFile(path);
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));
    const missing = REQUIRED_TABLES.filter((t) => !names.has(t));
    if (missing.length) throw new Error(`备份缺少关键表：${missing.join(', ')}`);
    return { tableCount: names.size, fkIssues: db.query('PRAGMA foreign_key_check').all().length };
  } finally {
    db.close();
  }
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');

/** WAL 模式下 `-wal` / `-shm` 与主库是一体的，必须整组一起搬走或清掉。 */
const SIDECARS = ['-wal', '-shm'];

function moveWithSidecars(from: string, to: string): void {
  renameSync(from, to);
  for (const side of SIDECARS) {
    if (existsSync(`${from}${side}`)) renameSync(`${from}${side}`, `${to}${side}`);
  }
}

function removeSidecars(path: string): void {
  for (const side of SIDECARS) rmSync(`${path}${side}`, { force: true });
}

export function restoreBackup(opts: RestoreOptions): RestoreResult {
  const { backupPath, targetPath } = opts;
  const { tableCount, fkIssues } = verifyBackup(backupPath);

  if (existsSync(targetPath) && !opts.force) {
    throw new Error(`目标数据库已存在：${targetPath}；确认要覆盖请加 --force`);
  }
  mkdirSync(dirname(targetPath), { recursive: true });

  let previousPath: string | null = null;
  if (existsSync(targetPath)) {
    // 连同 WAL 一起搬走：旧库的最新写入可能还只在 -wal 里，丢了就回退不了。
    previousPath = `${targetPath}.pre-restore-${stamp(opts.now ?? new Date())}`;
    moveWithSidecars(targetPath, previousPath);
  }
  // 目标位置的残留 WAL 属于被换掉的那个库，留着会让 SQLite 读到旧数据。
  removeSidecars(targetPath);

  try {
    copyFileSync(backupPath, targetPath);
    verifyDatabaseFile(targetPath);
  } catch (e) {
    // 恢复失败则回滚到原库，不留下半截状态。
    rmSync(targetPath, { force: true });
    if (previousPath) moveWithSidecars(previousPath, targetPath);
    throw e;
  }
  return { backupPath, targetPath, previousPath, tableCount, fkIssues };
}

/** 解析 `--to <值>` 与位置参数。 */
export function parseRestoreArgs(argv: string[]): { backupPath?: string; to?: string; force: boolean } {
  const positional: string[] = [];
  let to: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--to') {
      to = argv[++i];
      continue;
    }
    if (a.startsWith('--')) continue;
    positional.push(a);
  }
  return { backupPath: positional[0], to, force: argv.includes('--force') };
}

if (import.meta.main) {
  const { loadEnv } = await import('../src/env');
  const env = loadEnv();
  const { backupPath, to, force } = parseRestoreArgs(process.argv.slice(2));
  if (!backupPath) {
    console.error('用法：bun run db:restore <备份文件> [--to <目标库>] [--force]');
    process.exit(1);
  }
  try {
    const r = restoreBackup({ backupPath, targetPath: to ?? env.databaseUrl, force });
    console.log(`恢复完成：${r.backupPath} → ${r.targetPath}（${r.tableCount} 张表，完整性校验通过）`);
    if (r.fkIssues) console.warn(`注意：备份内有 ${r.fkIssues} 条外键异常，请人工确认数据是否可用。`);
    if (r.previousPath) console.log(`原数据库已另存为：${r.previousPath}（确认无误后可删除）`);
    console.log('提示：恢复后请重启服务，并访问 /health 与任意作品页确认可用。');
  } catch (e) {
    console.error('恢复失败：', e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
