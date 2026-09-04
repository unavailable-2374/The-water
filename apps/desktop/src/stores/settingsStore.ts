import { create } from 'zustand';
import { DEFAULT_SETTINGS, loadAppSettings, saveAppSettings, type AppSettings } from '@/db/repos/settingsRepo';
import { listProviders } from '@/db/repos/providersRepo';
import type { ProviderConfig } from '@/llm/types';
import { applyTheme } from '@/app/theme';

interface SettingsState {
  settings: AppSettings;
  providers: ProviderConfig[];
  loaded: boolean;
  load: () => Promise<void>;
  update: (patch: Partial<AppSettings>) => Promise<void>;
  refreshProviders: () => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  providers: [],
  loaded: false,
  load: async () => {
    const [settings, providers] = await Promise.all([loadAppSettings(), listProviders()]);
    set({ settings, providers, loaded: true });
  },
  update: async (patch) => {
    await saveAppSettings(patch);
    set({ settings: { ...get().settings, ...patch } });
    // 主题要立刻反映到 <html data-theme>，否则「设置无效」。
    if (patch.theme) applyTheme(patch.theme);
  },
  refreshProviders: async () => set({ providers: await listProviders() }),
}));
