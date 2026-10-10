/** Cloud sessions are memory-only unless the user explicitly chooses to remember login. */
import type { SyncAccount } from '@/db/repos/syncAccountRepo';
import { getSetting, setSetting } from '@/db/repos/settingsRepo';
import { getAccount, getSession, startSession, updateSessionProfile, clearSession } from './session';
import { PublicApi, normalizeServerUrl } from './api';
import { useSettings } from '@/stores/settingsStore';

export const DEFAULT_SERVER_URL = 'http://localhost:8787';
const SERVER_URL_SETTING = 'publicServerUrl';

export async function getClientId(): Promise<string> {
  return getSetting<string>('clientId', '');
}

/** Server used for anonymous browsing (falls back to the logged-in account's server, then the default). */
export async function getServerUrl(): Promise<string> {
  const account = await getAccount();
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

/** Authenticated client for the active session, or null when logged out. */
export async function getClient(): Promise<PublicApi | null> {
  const session = await getSession();
  if (!session) return null;
  return new PublicApi(session.account.serverUrl, async () => session.token, await getClientId());
}

/** Authenticated client when logged in, otherwise an anonymous one — for browsing/reading. */
export async function getBrowseClient(): Promise<PublicApi> {
  return (await getClient()) ?? getAnonymousClient();
}

async function persistSession(serverUrl: string, user: { id: string; displayName: string; handle?: string }, token: string, remember: boolean) {
  const account = await startSession({
    serverUrl: normalizeServerUrl(serverUrl),
    userId: user.id,
    displayName: user.displayName,
    handle: user.handle ?? '',
    tokenSecretRef: '',
  }, token, remember);
  await setServerUrl(serverUrl);
  await useSettings.getState().refreshProviders();
  return account;
}

/** Update the active profile, persisting it only for remembered sessions. */
export async function updateLocalProfile(patch: { displayName?: string; handle?: string }): Promise<SyncAccount | null> {
  return updateSessionProfile(patch);
}

export async function login(serverUrl: string, email: string, password: string, remember = false): Promise<SyncAccount & { rememberFailed: boolean }> {
  const api = await getAnonymousClient(serverUrl);
  const res = await api.login({ email: email.trim(), password, clientLabel: 'The Water 桌面版' });
  return persistSession(serverUrl, res.user, res.token, remember);
}

/** 注册。handle 留空时由服务端按 id 生成一个 `u_xxxxxxxxxxxx`。 */
export async function register(
  serverUrl: string,
  email: string,
  password: string,
  displayName: string,
  handle?: string,
  remember = false,
): Promise<SyncAccount & { rememberFailed: boolean }> {
  const api = await getAnonymousClient(serverUrl);
  const wanted = handle?.trim().toLowerCase();
  const res = await api.register({
    email: email.trim(),
    password,
    displayName: displayName.trim(),
    ...(wanted ? { handle: wanted } : {}),
    clientLabel: 'The Water 桌面版',
  });
  return persistSession(serverUrl, res.user, res.token, remember);
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
  await clearSession();
}

/** 注销账号：服务端匿名化并吊销全部会话，本地凭证随即清空。 */
export async function deleteAccount(password: string, mode: 'keep_works' | 'delete_works'): Promise<void> {
  const api = await getClient();
  if (!api) throw new Error('尚未登录');
  await api.deleteAccount({ password, mode });
  await clearSession();
}

/** Best-effort server-side logout, then always clear local credentials. */
export async function logout(): Promise<void> {
  const api = await getClient();
  if (api) await api.logout().catch(() => undefined);
  await clearSession();
  await useSettings.getState().refreshProviders();
}
