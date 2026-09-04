import Database from '@tauri-apps/plugin-sql';
import type { Db, ExecResult } from './db';

export const DB_URL = 'sqlite:the-water.db';

export async function openTauriDb(): Promise<Db> {
  const inner = await Database.load(DB_URL);
  return {
    async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return inner.select<T[]>(sql, params);
    },
    async execute(sql: string, params: unknown[] = []): Promise<ExecResult> {
      const r = await inner.execute(sql, params);
      return { rowsAffected: r.rowsAffected, lastInsertId: r.lastInsertId };
    },
  };
}
