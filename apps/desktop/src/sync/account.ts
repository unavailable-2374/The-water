/**
 * Cloud account plumbing: the bearer token lives in the OS keychain (ACCOUNT_TOKEN_REF),
 * the account row in `sync_account`, and the anonymous browse server URL in settings.
 */
import { clearSyncAccount, getSyncAccount, saveSyncAccount, type SyncAccount } from '@/db/repos/syncAccountRepo';
import { getSetting, setSetting } from '@/db/repos/settingsRepo';
import { ACCOUNT_TOKEN_REF, secrets } from '@/secrets/keychain';
import { PublicApi, normalizeServerUrl } from './api';

export const DEFAULT_SERVER_URL = 'http://localhost:8787';
const SERVER_URL_SETTING = 'publicServerUrl';

export async function getClientId(): Promise<string> {
  return getSetting<string>('clientId', '');
}

/** Server used for anonymous browsing (falls back to the logged-in account's server, then the default). */
export async function getServerUrl(): Promise<string> {
  const account = await getSyncAccount();
  if (account) return account.serverUrl;
  const saved = await getSetting<string>(SERVER_URL_SETTING, '');
  return saved ? normalizeServerUrl(saved) : DEFAULT_SERVER_URL;
}

export async function setServerUrl(url: string): Promise<void> {
  await setSetting(SERVER_URL_SETTING, normalizeServerUrl(url) || DEFAULT_SERVER_URL);
}

export async function getAnonymousClient(serverUrl?: string): Promise<PublicApi> {
  const url = serverUrl ? normalizeServerUrl(serverUrl) : await getServerUrl();
  return new PublicApi(url, async () => null, await getClientId());
}

/** Authenticated client for the saved account, or null when logged out. */
export async function getClient(): Promise<PublicApi | null> {
  const account = await getSyncAccount();
  if (!account) return null;
  const token = await secrets().get(account.tokenSecretRef).catch(() => null);
  if (!token) return null;
  return new PublicApi(account.serverUrl, async () => token, await getClientId());
}

/** Authenticated client when logged in, otherwise an anonymous one — for browsing/reading. */
export async function getBrowseClient(): Promise<PublicApi> {
  return (await getClient()) ?? getAnonymousClient();
}

async function persistSession(serverUrl: string, user: { id: string; displayName: string; handle?: string }, token: string): Promise<SyncAccount> {
  await secrets().set(ACCOUNT_TOKEN_REF, token);
  await saveSyncAccount({
    serverUrl: normalizeServerUrl(serverUrl),
    userId: user.id,
    displayName: user.displayName,
    handle: user.handle ?? '',
    tokenSecretRef: ACCOUNT_TOKEN_REF,
  });
  await setServerUrl(serverUrl);
  return (await getSyncAccount())!;
}

/** 改完云端资料后同步本地这一行，让侧栏与「我的主页」立刻用上新名字。 */
export async function updateLocalProfile(patch: { displayName?: string; handle?: string }): Promise<SyncAccount | null> {
  const account = await getSyncAccount();
  if (!account) return null;
  await saveSyncAccount({
    serverUrl: account.serverUrl,
    userId: account.userId,
    displayName: patch.displayName ?? account.displayName,
    handle: patch.handle ?? account.handle,
    tokenSecretRef: account.tokenSecretRef,
  });
  return getSyncAccount();
}

export async function login(serverUrl: string, email: string, password: string): Promise<SyncAccount> {
  const api = await getAnonymousClient(serverUrl);
  const res = await api.login({ email: email.trim(), password, clientLabel: 'The Water 桌面版' });
  return persistSession(serverUrl, res.user, res.token);
}

/** 注册。handle 留空时由服务端按 id 生成一个 `u_xxxxxxxxxxxx`。 */
export async function register(
  serverUrl: string,
  email: string,
  password: string,
  displayName: string,
  handle?: string,
): Promise<SyncAccount> {
  const api = await getAnonymousClient(serverUrl);
  const wanted = handle?.trim().toLowerCase();
  const res = await api.register({
    email: email.trim(),
    password,
    displayName: displayName.trim(),
    ...(wanted ? { handle: wanted } : {}),
    clientLabel: 'The Water 桌面版',
  });
  return persistSession(serverUrl, res.user, res.token);
}

/** 忘记密码：匿名调用，服务端不会说这个邮箱有没有注册过。 */
export async function forgotPassword(serverUrl: string, email: string): Promise<void> {
  const api = await getAnonymousClient(serverUrl);
  await api.forgotPassword(email.trim());
}

/** 用邮件里的验证码重置密码。成功后全部会话失效，本地凭证也一并清掉。 */
export async function resetPassword(serverUrl: string, token: string, password: string): Promise<void> {
  const api = await getAnonymousClient(serverUrl);
  await api.resetPassword(token.trim(), password);
  await secrets().delete(ACCOUNT_TOKEN_REF).catch(() => undefined);
  await clearSyncAccount();
}

/** 注销账号：服务端匿名化并吊销全部会话，本地凭证随即清空。 */
export async function deleteAccount(password: string, mode: 'keep_works' | 'delete_works'): Promise<void> {
  const api = await getClient();
  if (!api) throw new Error('尚未登录');
  await api.deleteAccount({ password, mode });
  await secrets().delete(ACCOUNT_TOKEN_REF).catch(() => undefined);
  await clearSyncAccount();
}

/** Best-effort server-side logout, then always clear local credentials. */
export async function logout(): Promise<void> {
  const api = await getClient();
  if (api) await api.logout().catch(() => undefined);
  await secrets().delete(ACCOUNT_TOKEN_REF).catch(() => undefined);
  await clearSyncAccount();
}
