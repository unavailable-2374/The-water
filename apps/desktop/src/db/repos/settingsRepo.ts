import { getDb, selectOne } from '../db';

export interface AppSettings {
  defaultProviderId: { chat: string | null; writing: string | null; planning: string | null };
  autoResumeJobs: boolean;
  countMode: 'all' | 'han';
  theme: 'system' | 'light' | 'dark';
  clientId: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultProviderId: { chat: null, writing: null, planning: null },
  autoResumeJobs: true,
  countMode: 'all',
  theme: 'system',
  clientId: '',
};

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await selectOne<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await getDb().execute(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, JSON.stringify(value)],
  );
}

export async function loadAppSettings(): Promise<AppSettings> {
  const rows = await getDb().select<{ key: string; value: string }>('SELECT key, value FROM settings');
  const out: AppSettings = structuredClone(DEFAULT_SETTINGS);
  for (const r of rows) {
    if (r.key in out) {
      try {
        (out as unknown as Record<string, unknown>)[r.key] = JSON.parse(r.value);
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

export async function saveAppSettings(patch: Partial<AppSettings>): Promise<void> {
  for (const [k, v] of Object.entries(patch)) await setSetting(k, v);
}
