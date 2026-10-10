import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db, ExecResult } from '@/db/db';
import { setDb } from '@/db/db';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../src-tauri/migrations/', import.meta.url));

/** In-memory SQLite implementing the app's Db interface, with every real migration applied in order. */
export function createTestDb(existingFile?: string): Db & { raw: DatabaseSync } {
  const restored = !!existingFile && existsSync(existingFile);
  const raw = new DatabaseSync(existingFile ?? ':memory:');
  raw.exec('PRAGMA foreign_keys=ON');
  for (const f of restored ? [] : readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(MIGRATIONS_DIR + f, 'utf8').replace(/PRAGMA journal_mode = WAL;/, ''));
  }
  const db: Db & { raw: DatabaseSync } = {
    raw,
    async atomic(operations) {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const results = operations.map((op) => {
          const r = raw.prepare(op.sql).run(...((op.params ?? []) as never[]));
          if (op.expectedRows !== undefined && Number(r.changes) !== op.expectedRows) throw new Error('Concurrent modification: atomic precondition failed');
          return { rowsAffected: Number(r.changes), lastInsertId: Number(r.lastInsertRowid) };
        });
        raw.exec('COMMIT');
        return results;
      } catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
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

export function useTestDb(existingFile?: string, mode: 'local' | 'server' = 'local'): Db & { raw: DatabaseSync } {
  const db = createTestDb(existingFile);
  // TEST fixtures explicitly select their existing local transport; production defaults to server.
  db.raw.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('aiServiceMode', JSON.stringify(mode));
  setDb(db);
  return db;
}
