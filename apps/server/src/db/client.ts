import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema';

export type Db = ReturnType<typeof createDb>['db'];

export function createDb(url: string) {
  const isMemory = url === ':memory:' || url === '';
  if (!isMemory) mkdirSync(dirname(url), { recursive: true });
  const sqlite = new Database(isMemory ? ':memory:' : url, { create: true, strict: true });
  if (!isMemory) sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec('PRAGMA busy_timeout = 5000;');
  const db = drizzle({ client: sqlite, schema, casing: 'snake_case' });
  return { db, sqlite };
}

/** drizzle bun-sqlite 的 run() 类型为 void，但运行时返回 bun:sqlite 的 Changes；此处安全取值。 */
export function changes(res: unknown): number {
  const c = (res as { changes?: number | bigint } | undefined)?.changes;
  return typeof c === 'number' ? c : typeof c === 'bigint' ? Number(c) : 0;
}
