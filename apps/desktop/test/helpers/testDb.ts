import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db, ExecResult } from '@/db/db';
import { setDb } from '@/db/db';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../src-tauri/migrations/', import.meta.url));

/** In-memory SQLite implementing the app's Db interface, with every real migration applied in order. */
export function createTestDb(): Db & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(MIGRATIONS_DIR + f, 'utf8').replace(/PRAGMA journal_mode = WAL;/, ''));
  }
  const db: Db & { raw: DatabaseSync } = {
    raw,
    async select<T>(q: string, params: unknown[] = []): Promise<T[]> {
      return raw.prepare(q).all(...(params as never[])) as T[];
    },
    async execute(q: string, params: unknown[] = []): Promise<ExecResult> {
      const r = raw.prepare(q).run(...(params as never[]));
      return { rowsAffected: Number(r.changes), lastInsertId: Number(r.lastInsertRowid) };
    },
  };
  return db;
}

export function useTestDb(): Db & { raw: DatabaseSync } {
  const db = createTestDb();
  setDb(db);
  return db;
}
