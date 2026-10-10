import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/testDb';

// TEST SIMULATED native storage and HTTP responses. No real Keychain or credentials are used.
const native = vi.hoisted(() => ({ invoke: vi.fn(), refresh: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@/stores/settingsStore', () => ({ useSettings: { getState: () => ({ refreshProviders: native.refresh }) } }));
vi.mock('@/secrets/keychain', () => ({ secrets: () => { throw new Error('TEST unexpected Keychain access'); } }));
const identity = { serverUrl: 'https://TEST.invalid', userId: 'TEST-user', displayName: 'TEST name', handle: 'test-user', tokenSecretRef: '' };
let db: ReturnType<typeof createTestDb>;
async function modules() {
  const { setDb } = await import('@/db/db');
  setDb(db);
  return { session: await import('@/sync/session'), repo: await import('@/db/repos/syncAccountRepo') };
}
beforeEach(() => {
  vi.resetModules();
  native.invoke.mockReset();
  native.invoke.mockResolvedValue(null);
  native.refresh.mockClear();
  db = createTestDb();
});
afterEach(() => { db.raw.close(); vi.unstubAllGlobals(); });

describe('explicit account session persistence', () => {
  it('ordinary login keeps the account and token in memory without any native credential access', async () => {
    const { session, repo } = await modules();
    await session.startSession(identity, 'TEST-token');
    expect(await session.getAccount()).toMatchObject({ userId: 'TEST-user', tokenSecretRef: '' });
    expect((await session.getSession())?.token).toBe('TEST-token');
    await session.updateSessionProfile({ displayName: 'TEST renamed' });
    expect((await session.getAccount())?.displayName).toBe('TEST renamed');
    expect(await repo.getSyncAccount()).toBeNull();
    expect(native.invoke).not.toHaveBeenCalled();
    vi.resetModules();
    expect(await (await modules()).session.getAccount()).toBeNull();
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it('never restores or deletes legacy Keychain credentials', async () => {
    const { session, repo } = await modules();
    await repo.saveSyncAccount({ ...identity, tokenSecretRef: 'account:token' });
    expect(await session.getSession()).toBeNull();
    await session.startSession(identity, 'TEST-token');
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it('restores only an explicitly remembered session once, including concurrent callers', async () => {
    const { session, repo } = await modules();
    expect(await session.startSession(identity, 'TEST-token', true)).toMatchObject({ rememberFailed: false });
    expect(native.invoke).toHaveBeenCalledWith('account_session_write', { token: 'TEST-token' });
    expect((await repo.getSyncAccount())?.tokenSecretRef).toBe(session.SESSION_TOKEN_REF);
    await session.updateSessionProfile({ displayName: 'TEST remembered name' });
    vi.resetModules(); native.invoke.mockClear(); native.invoke.mockResolvedValue('TEST-token');
    const restarted = (await modules()).session;
    const accounts = await Promise.all([restarted.getAccount(), restarted.getAccount()]);
    expect(accounts[0]?.displayName).toBe('TEST remembered name');
    expect(accounts[1]?.userId).toBe('TEST-user');
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith('account_session_read');
    await restarted.clearSession();
    expect(await restarted.getAccount()).toBeNull();
    expect(await repo.getSyncAccount()).toBeNull();
    expect(native.invoke).toHaveBeenCalledWith('account_session_delete');
  });
  it('storage refusal is reported while keeping the successfully authenticated session usable', async () => {
    const { session, repo } = await modules();
    native.invoke.mockRejectedValueOnce(new Error('TEST permission denied'));
    expect(await session.startSession(identity, 'TEST-token', true)).toMatchObject({ rememberFailed: true });
    expect((await session.getSession())?.token).toBe('TEST-token');
    expect(await repo.getSyncAccount()).toBeNull();
  });
  it('unchecking remember removes a previous session file and keeps the new login transient', async () => {
    const { session, repo } = await modules();
    await session.startSession(identity, 'TEST-old', true);
    native.invoke.mockClear();
    await session.startSession(identity, 'TEST-new', false);
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('account_session_delete');
    expect(await repo.getSyncAccount()).toBeNull();
    expect((await session.getSession())?.token).toBe('TEST-new');
  });
  it('a pending restore cannot overwrite a newer transient login', async () => {
    const { session, repo } = await modules();
    await repo.saveSyncAccount({ ...identity, tokenSecretRef: session.SESSION_TOKEN_REF });
    let finish!: (value: string) => void;
    native.invoke.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
    const pending = session.getSession();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await session.startSession({ ...identity, userId: 'TEST-new-user' }, 'TEST-new');
    finish('TEST-stale');
    expect((await pending)?.account.userId).toBe('TEST-new-user');
    expect((await session.getSession())?.token).toBe('TEST-new');
  });
  it('logout waits for a pending save before deleting persisted credentials', async () => {
    const { session, repo } = await modules();
    let finish!: () => void;
    native.invoke.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const saving = session.startSession(identity, 'TEST-token', true);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const logout = session.clearSession();
    finish();
    await Promise.all([saving, logout]);
    expect(await session.getSession()).toBeNull();
    expect(await repo.getSyncAccount()).toBeNull();
    expect(native.invoke.mock.calls.map(call => call[0])).toEqual(['account_session_write', 'account_session_delete']);
  });
  it('login, account store, and backend model service work with a transient session', async () => {
    const { session, repo } = await modules();
    const account = await import('@/sync/account');
    const { PublicApi } = await import('@/sync/api');
    const { useAccount } = await import('@/stores/accountStore');
    const { serverProvider } = await import('@/llm/serverProvider');
    const caps = { enabled: true, engine: 'pi' as const, protocolVersion: 1 as const, provider: 'lunaroute' as const, model: 'TEST-model', contextWindow: 10000, maxOutputTokens: 1000, reasoningTokens: 0, reasoningEffort: 'low' as const, jsonMode: 'json_schema' as const, retentionHours: 168 };
    const loginSpy = vi.spyOn(PublicApi.prototype, 'login').mockResolvedValue({ token: 'TEST-token', user: { id: identity.userId, displayName: identity.displayName, handle: identity.handle } } as Awaited<ReturnType<InstanceType<typeof PublicApi>['login']>>);
    const capsSpy = vi.spyOn(PublicApi.prototype, 'writingCapabilities').mockResolvedValue(caps);
    const logoutSpy = vi.spyOn(PublicApi.prototype, 'logout').mockResolvedValue({ ok: true });
    try {
      await account.login(identity.serverUrl, 'TEST@example.invalid', 'TEST-password');
      await useAccount.getState().refresh();
      expect(useAccount.getState().account?.userId).toBe('TEST-user');
      expect((await serverProvider()).config.model).toBe('TEST-model');
      expect(await account.getClient()).not.toBeNull();
      expect(await repo.getSyncAccount()).toBeNull();
      expect(native.invoke).not.toHaveBeenCalled();
      await account.logout();
      expect(await session.getSession()).toBeNull();
      expect(native.invoke).toHaveBeenCalledExactlyOnceWith('account_session_delete');
    } finally { loginSpy.mockRestore(); capsSpy.mockRestore(); logoutSpy.mockRestore(); }
  });
});
