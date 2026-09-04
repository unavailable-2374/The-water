import { getDb, now, selectOne } from '../db';

export interface SyncAccount { serverUrl: string; userId: string; displayName: string; handle: string; tokenSecretRef: string; updatedAt: number }
interface Raw { server_url: string; user_id: string; display_name: string; handle: string; token_secret_ref: string; updated_at: number }

export async function getSyncAccount(): Promise<SyncAccount | null> {
  const r = await selectOne<Raw>('SELECT * FROM sync_account WHERE id = 1');
  return r ? { serverUrl: r.server_url, userId: r.user_id, displayName: r.display_name, handle: r.handle ?? '', tokenSecretRef: r.token_secret_ref, updatedAt: r.updated_at } : null;
}
export async function saveSyncAccount(a: Omit<SyncAccount, 'updatedAt'>): Promise<void> {
  await getDb().execute(
    `INSERT INTO sync_account(id, server_url, user_id, display_name, handle, token_secret_ref, updated_at) VALUES (1,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET server_url=excluded.server_url, user_id=excluded.user_id, display_name=excluded.display_name, handle=excluded.handle, token_secret_ref=excluded.token_secret_ref, updated_at=excluded.updated_at`,
    [a.serverUrl.replace(/\/+$/, ''), a.userId, a.displayName, a.handle, a.tokenSecretRef, now()],
  );
}
export async function clearSyncAccount(): Promise<void> {
  await getDb().execute('DELETE FROM sync_account WHERE id = 1');
}
