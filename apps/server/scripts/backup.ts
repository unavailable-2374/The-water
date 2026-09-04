/**
 * 在线一致性备份：SQLite `VACUUM INTO` + GFS 轮转（7 日 / 4 周 / 12 月）。
 *
 * `VACUUM INTO` 对源库是只读操作，服务进程运行中也能安全执行，
 * 产出的是一个已整理、无 WAL 尾巴的独立单文件，可直接当作恢复源。
 *
 * 用法：
 *   bun run db:backup                 # 用 env 的 DATABASE_URL / BACKUP_DIR
 *   bun run db:backup --db ./data/dev.sqlite --dir ./data/backups
 *   bun run db:backup --no-prune      # 只备份，不做保留策略清理
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 备份文件名：the-water-YYYYMMDD-HHMMSS.sqlite（UTC 时间戳，字典序即时间序）。 */
const NAME_RE = /^the-water-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.sqlite$/;

export interface RetentionPolicy {
  /** 保留最近 N 个"每日"备份（每天只留当天最新一个）。 */
  daily: number;
  /** 保留最近 N 个"每周"备份。 */
  weekly: number;
  /** 保留最近 N 个"每月"备份。 */
  monthly: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { daily: 7, weekly: 4, monthly: 12 };

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function backupFileName(at: Date): string {
  const y = at.getUTCFullYear();
  const stamp = `${y}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
  return `the-water-${stamp}.sqlite`;
}

/** 解析备份文件名中的 UTC 时间戳；不是备份文件返回 null。 */
export function parseBackupTime(name: string): Date | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

const dayBucket = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const monthBucket = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;

/** ISO 周桶（周一为一周之始），跨年边界由 ISO-8601 规则处理。 */
function weekBucket(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // 移到本周的周四：ISO 周所属年份由周四决定。
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad(week)}`;
}

export interface BackupEntry {
  name: string;
  at: Date;
}

/** 列出目录里所有符合命名规范的备份，按时间倒序（最新在前）。 */
export function listBackups(dir: string): BackupEntry[] {
  if (!existsSync(dir)) return [];
  const out: BackupEntry[] = [];
  for (const name of readdirSync(dir)) {
    const at = parseBackupTime(name);
    if (at) out.push({ name, at });
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime());
}

/**
 * GFS 轮转判定：分别按天 / ISO 周 / 月分桶，每个桶只留桶内最新的一份，
 * 再各自保留最近 daily / weekly / monthly 个桶；三份保留集合取并集，其余淘汰。
 * 最新一次备份必然落在最近的日桶里，因此永远不会被删。
 */
export function planRetention(
  entries: BackupEntry[],
  policy: RetentionPolicy = DEFAULT_RETENTION,
): { keep: BackupEntry[]; drop: BackupEntry[] } {
  const sorted = [...entries].sort((a, b) => b.at.getTime() - a.at.getTime());
  const keep = new Set<string>();

  const takeBuckets = (bucketOf: (d: Date) => string, count: number) => {
    const seen = new Set<string>();
    for (const e of sorted) {
      const b = bucketOf(e.at);
      if (seen.has(b)) continue; // 桶内只留最新一份
      if (seen.size >= count) break;
      seen.add(b);
      keep.add(e.name);
    }
  };
  takeBuckets(dayBucket, policy.daily);
  takeBuckets(weekBucket, policy.weekly);
  takeBuckets(monthBucket, policy.monthly);

  return {
    keep: sorted.filter((e) => keep.has(e.name)),
    drop: sorted.filter((e) => !keep.has(e.name)),
  };
}

/** 对备份文件做 `PRAGMA integrity_check`；不通过抛错。 */
export function verifyDatabaseFile(path: string): void {
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.query('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
    const first = rows[0] ? String(Object.values(rows[0])[0]) : '';
    if (rows.length !== 1 || first !== 'ok') {
      throw new Error(`完整性校验未通过：${rows.map((r) => Object.values(r)[0]).join('; ')}`);
    }
  } finally {
    db.close();
  }
}

export interface BackupOptions {
  databaseUrl: string;
  backupDir: string;
  now?: Date;
  /** 备份后是否执行保留策略清理，默认执行。 */
  prune?: boolean;
  retention?: RetentionPolicy;
}

export interface BackupResult {
  path: string;
  byteSize: number;
  /** 按保留策略删除的旧备份文件名。 */
  removed: string[];
}

export function createBackup(opts: BackupOptions): BackupResult {
  const { databaseUrl, backupDir } = opts;
  if (!existsSync(databaseUrl)) throw new Error(`源数据库不存在：${databaseUrl}`);
  mkdirSync(backupDir, { recursive: true });

  const now = opts.now ?? new Date();
  let target = join(backupDir, backupFileName(now));
  // 同一秒内重复执行时避让，`VACUUM INTO` 不允许目标已存在。
  for (let i = 1; existsSync(target) && i < 60; i++) {
    target = join(backupDir, backupFileName(new Date(now.getTime() + i * 1000)));
  }
  if (existsSync(target)) throw new Error(`备份目标已存在：${target}`);

  // 用可写连接打开：`VACUUM INTO` 本身不改源库，但服务异常退出后遗留的 WAL
  // 需要可写连接才能回放，只读连接会直接报 disk I/O error。
  const src = new Database(databaseUrl);
  try {
    src.run('VACUUM INTO ?', [target]);
  } finally {
    src.close();
  }

  // 先验证新备份可用，再动旧备份——校验失败时保留策略不执行，历史备份不受牵连。
  verifyDatabaseFile(target);

  const removed =
    opts.prune === false ? [] : pruneBackups(backupDir, opts.retention ?? DEFAULT_RETENTION);
  return { path: target, byteSize: statSync(target).size, removed };
}

/** 按保留策略删除过期备份，返回被删掉的文件名。 */
export function pruneBackups(dir: string, retention: RetentionPolicy = DEFAULT_RETENTION): string[] {
  const { drop } = planRetention(listBackups(dir), retention);
  for (const e of drop) rmSync(join(dir, e.name), { force: true });
  return drop.map((e) => e.name);
}

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (import.meta.main) {
  const { loadEnv } = await import('../src/env');
  const env = loadEnv();
  const argv = process.argv.slice(2);
  const databaseUrl = arg(argv, '--db') ?? env.databaseUrl;
  const backupDir = arg(argv, '--dir') ?? env.backupDir;
  try {
    const r = createBackup({ databaseUrl, backupDir, prune: !argv.includes('--no-prune') });
    console.log(`备份完成：${r.path}（${(r.byteSize / 1024 / 1024).toFixed(2)} MB，完整性校验通过）`);
    if (r.removed.length) console.log(`按保留策略清理 ${r.removed.length} 个旧备份：${r.removed.join(', ')}`);
    console.log(`当前保留 ${listBackups(backupDir).length} 个备份于 ${backupDir}`);
  } catch (e) {
    console.error('备份失败：', e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
