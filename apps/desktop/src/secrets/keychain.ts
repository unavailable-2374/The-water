import { invoke } from '@tauri-apps/api/core';

/**
 * Secrets live in the OS keychain. A `secretRef` of the form `env:NAME` is resolved from the
 * process environment at runtime instead (dev convenience; never persisted).
 */
export interface SecretStore {
  get(ref: string): Promise<string | null>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

export const tauriSecrets: SecretStore = {
  async get(ref) {
    if (!ref) return null;
    if (ref.startsWith('env:')) {
      return (await invoke<string | null>('read_env_api_key', { name: ref.slice(4) })) ?? null;
    }
    return (await invoke<string | null>('secret_get', { name: ref })) ?? null;
  },
  async set(ref, value) {
    if (ref.startsWith('env:')) throw new Error('env 引用不可写入');
    await invoke('secret_set', { name: ref, value });
  },
  async delete(ref) {
    if (ref.startsWith('env:')) return;
    await invoke('secret_delete', { name: ref });
  },
};

let store: SecretStore = tauriSecrets;
export function setSecretStore(s: SecretStore): void {
  store = s;
}
export function secrets(): SecretStore {
  return store;
}

export function providerSecretRef(providerId: string): string {
  return `provider:${providerId}`;
}
export const ACCOUNT_TOKEN_REF = 'account:token';
