import { invoke } from '@tauri-apps/api/core';
import { now } from '@/db/db';
import { clearSyncAccount, getSyncAccount, saveSyncAccount, type SyncAccount } from '@/db/repos/syncAccountRepo';

export const SESSION_TOKEN_REF = 'account:session-file';
export interface AccountSession { account: SyncAccount; token: string; remembered: boolean }
let current: AccountSession | null | undefined;
let restoration: Promise<AccountSession | null> | undefined;
let generation = 0;
let mutations: Promise<unknown> = Promise.resolve();

/** Serialize session changes so a delayed save cannot recreate credentials after logout. */
function mutate<T>(action: () => Promise<T>): Promise<T> {
  const result = mutations.then(action, action);
  mutations = result.catch(() => undefined);
  return result;
}

/** Restore only an explicitly remembered session. Never read legacy Keychain credentials. */
export async function getSession(): Promise<AccountSession | null> {
  if (current !== undefined) return current;
  if (!restoration) {
    const started = generation;
    restoration = (async () => {
      const account = await getSyncAccount();
      const token = account?.tokenSecretRef === SESSION_TOKEN_REF
        ? await invoke<string | null>('account_session_read').catch(() => null) : null;
      const restored = account && token ? { account, token, remembered: true } : null;
      if (generation === started) current = restored;
      return current ?? null;
    })();
  }
  return restoration;
}

export async function getAccount(): Promise<SyncAccount | null> {
  return (await getSession())?.account ?? null;
}

/** Default login is memory-only. Optional persistence failure cannot undo successful authentication. */
export async function startSession(account: Omit<SyncAccount, 'updatedAt'>, token: string, remember = false): Promise<SyncAccount & { rememberFailed: boolean }> {
  return mutate(async () => {
    generation++;
    current = { account: { ...account, tokenSecretRef: '', updatedAt: now() }, token, remembered: false };
    const previous = await getSyncAccount();
    await clearSyncAccount();
    let rememberFailed = false;
    if (!remember && previous?.tokenSecretRef === SESSION_TOKEN_REF) {
      await invoke('account_session_delete').catch(() => { rememberFailed = true; });
    }
    if (remember) {
      try {
        await invoke('account_session_write', { token });
        await saveSyncAccount({ ...account, tokenSecretRef: SESSION_TOKEN_REF });
        current.account.tokenSecretRef = SESSION_TOKEN_REF;
        current.remembered = true;
      } catch {
        rememberFailed = true;
        await clearSyncAccount();
        await invoke('account_session_delete').catch(() => undefined);
      }
    }
    return { ...current.account, rememberFailed };
  });
}

export async function updateSessionProfile(patch: { displayName?: string; handle?: string }): Promise<SyncAccount | null> {
  return mutate(async () => {
    const session = await getSession();
    if (!session) return null;
    session.account = { ...session.account, ...patch, updatedAt: now() };
    if (session.remembered) await saveSyncAccount(session.account);
    return session.account;
  });
}

/** Drop metadata and the private session file; old Keychain entries are left untouched. */
export async function clearSession(): Promise<void> {
  return mutate(async () => {
    generation++;
    current = null;
    await clearSyncAccount();
    await invoke('account_session_delete');
  });
}
