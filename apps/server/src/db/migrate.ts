import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { join } from 'node:path';
import type { Db } from './client';

const MIGRATIONS_FOLDER = join(import.meta.dir, '..', '..', 'drizzle');

export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

if (import.meta.main) {
  const { loadEnv } = await import('../env');
  const { createDb } = await import('./client');
  const env = loadEnv();
  const { db } = createDb(env.databaseUrl);
  runMigrations(db);
  console.log(`迁移完成：${env.databaseUrl}`);
}
