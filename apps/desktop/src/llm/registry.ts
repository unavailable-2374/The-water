import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { createProvider } from './factory';
import { detachAbortAfterHeaders } from './timeout';
import type { FetchLike, LLMProvider, ProviderConfig } from './types';
import { getDefaultProvider, getProvider, listProviders } from '@/db/repos/providersRepo';
import { secrets } from '@/secrets/keychain';
import { getSetting } from '@/db/repos/settingsRepo';
import { serverProvider, SERVER_PROVIDER_ID } from './serverProvider';

export type ProviderPurpose = 'chat' | 'writing' | 'planning';

// 见 detachAbortAfterHeaders 的注释：不包一层的话，每次成功的 AI 调用都会弹
// 一条「The resource id N is invalid」。
let fetchImpl: FetchLike = detachAbortAfterHeaders(tauriFetch as unknown as FetchLike);
export function setFetchImpl(f: FetchLike): void {
  fetchImpl = detachAbortAfterHeaders(f);
}

const cache = new Map<string, { updatedAt: number; provider: LLMProvider }>();

export function invalidateProvider(id?: string): void {
  if (id) cache.delete(id);
  else cache.clear();
}

export async function resolveApiKey(config: ProviderConfig): Promise<string> {
  const key = await secrets().get(config.secretRef);
  if (!key) throw new Error(`供应商「${config.name}」未配置 API Key`);
  return key;
}

export async function providerFromConfig(config: ProviderConfig): Promise<LLMProvider> {
  const hit = cache.get(config.id);
  if (hit && hit.updatedAt === config.updatedAt) return hit.provider;
  const apiKey = await resolveApiKey(config);
  const provider = createProvider(config, apiKey, fetchImpl);
  cache.set(config.id, { updatedAt: config.updatedAt, provider });
  return provider;
}

export async function providerById(id: string): Promise<LLMProvider> {
  if (id === SERVER_PROVIDER_ID || await getSetting('aiServiceMode', 'server') === 'server') return (await serverProvider()).provider;
  const cfg = await getProvider(id);
  if (!cfg) throw new Error('供应商不存在');
  return providerFromConfig(cfg);
}

/** Resolve the provider for a purpose: explicit setting → default → first. */
export async function providerForPurpose(purpose: ProviderPurpose): Promise<{ config: ProviderConfig; provider: LLMProvider }> {
  if (await getSetting('aiServiceMode', 'server') === 'server') return serverProvider();
  const prefs = await getSetting<Record<ProviderPurpose, string | null>>('defaultProviderId', { chat: null, writing: null, planning: null });
  let cfg: ProviderConfig | null = null;
  const wanted = prefs[purpose];
  if (wanted) { cfg = await getProvider(wanted); if (!cfg) throw new Error('指定的默认供应商不存在，请重新选择'); }
  if (!cfg) cfg = await getDefaultProvider();
  if (!cfg) {
    const all = await listProviders();
    cfg = all[0] ?? null;
  }
  if (!cfg) throw new Error('尚未配置任何 AI 供应商，请先到设置中添加');
  return { config: cfg, provider: await providerFromConfig(cfg) };
}
