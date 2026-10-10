/** Minimal DB interface implemented by tauri-plugin-sql in the app and node:sqlite in tests. */
export interface ExecResult {
  rowsAffected: number;
  lastInsertId?: number;
}

/** Executed on one SQLite connection. A failed compare-and-swap rolls back every operation. */
export interface AtomicOperation {
  sql: string;
  params?: unknown[];
  expectedRows?: number;
}

export interface Db {
  select<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<ExecResult>;
  atomic(operations: AtomicOperation[]): Promise<ExecResult[]>;
}

let current: Db | null = null;

export function setDb(db: Db): void {
  current = db;
}

export function getDb(): Db {
  if (!current) throw new Error('数据库尚未初始化');
  return current;
}

export function now(): number {
  return Date.now();
}

export async function selectOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
  const rows = await getDb().select<T>(sql, params);
  return rows[0] ?? null;
}

/** Optional transaction boundary used by the assistant; manual callers use the same operations. */
export type AtomicWriter = (operations: AtomicOperation[]) => Promise<unknown>;
export const writeAtomic: AtomicWriter = (operations) => getDb().atomic(operations);
export function writeStatement(commit: AtomicWriter, sql: string, params: unknown[] = []): Promise<unknown> {
  return commit([{ sql, params }]);
}
