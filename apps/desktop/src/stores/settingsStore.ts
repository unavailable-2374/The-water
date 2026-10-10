import { create } from 'zustand';
import { DEFAULT_SETTINGS, loadAppSettings, saveAppSettings, type AppSettings } from '@/db/repos/settingsRepo';
import { listProviders } from '@/db/repos/providersRepo';
import type { ProviderConfig } from '@/llm/types';
import { applyTheme } from '@/app/theme';
import { serverProvider } from '@/llm/serverProvider';

async function visibleProviders(settings: AppSettings): Promise<{ providers: ProviderConfig[]; providerError: string | null }> {
  if (settings.aiServiceMode === 'local') return { providers: await listProviders(), providerError: null };
  try { return { providers: [(await serverProvider()).config], providerError: null }; }
  catch (error) { return { providers: [], providerError: error instanceof Error ? error.message : String(error) }; }
}

let providerRefreshId = 0;

interface SettingsState {
  settings: AppSettings;
  providers: ProviderConfig[];
  providerError: string | null;
  loaded: boolean;
  load: () => Promise<void>;
  update: (patch: Partial<AppSettings>) => Promise<void>;
  refreshProviders: () => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  providers: [],
  providerError: null,
  loaded: false,
  load: async () => {
    const settings = await loadAppSettings();
    const result = await visibleProviders(settings);
    set({ settings, ...result, loaded: true });
  },
  update: async (patch) => {
    await saveAppSettings(patch);
    set({ settings: { ...get().settings, ...patch } });
    // 主题要立刻反映到 <html data-theme>，否则「设置无效」。
    if (patch.theme) applyTheme(patch.theme);
    if (patch.aiServiceMode) await get().refreshProviders();
  },
  refreshProviders: async () => {
    const requestId = ++providerRefreshId;
    const settings = get().settings;
    const result = await visibleProviders(settings);
    if (requestId === providerRefreshId && settings.aiServiceMode === get().settings.aiServiceMode) set(result);
  },
}));
