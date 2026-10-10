import { startAssistantRuntime } from '@/assistant/runtime';
import { recoverStoryOptions } from '@/db/repos/storyOptionsRepo';
import { nanoid } from 'nanoid';
import { setDb } from '@/db/db';
import { openTauriDb } from '@/db/tauriDb';
import { createProvider, listProviders } from '@/db/repos/providersRepo';
import { getSetting, setSetting } from '@/db/repos/settingsRepo';
import { secrets } from '@/secrets/keychain';
import { PROVIDER_PRESETS } from '@/llm/factory';
import { useSettings } from '@/stores/settingsStore';
import { startJobRunner } from '@/jobs/runner';
import { useJobs, wireJobsStore } from '@/stores/jobsStore';
import { useAccount } from '@/stores/accountStore';
import { watchAccountForCommunity } from '@/stores/communityStore';
import { applyTheme } from './theme';
import { fmt, t } from '@/i18n';
import { runStartupMaintenance } from '@/db/maintenance';

/** First-run: if no providers exist and an env API key is present, seed a provider that reads it at runtime. */
async function seedProvidersFromEnv(): Promise<void> {
  const existing = await listProviders();
  if (existing.length > 0) return;
  for (const p of PROVIDER_PRESETS) {
    if (!p.envVar) continue;
    const key = await secrets().get(`env:${p.envVar}`).catch(() => null);
    if (!key) continue;
    await createProvider({
      name: fmt(t.common.providerFromEnv, { name: p.name }), kind: p.kind, baseUrl: p.baseUrl, model: p.model, contextWindow: p.contextWindow,
      maxOutputTokens: p.maxOutputTokens, jsonMode: p.jsonMode, temperature: 0.8, extraHeaders: {}, secretRef: `env:${p.envVar}`, isDefault: true,
    });
    break;
  }
}

async function ensureClientId(): Promise<void> {
  const id = await getSetting<string>('clientId', '');
  if (!id) await setSetting('clientId', nanoid(24));
}

export async function bootstrap(): Promise<void> {
  const db = await openTauriDb();
  setDb(db);
  await recoverStoryOptions();
  await (await import('@/novel/outlineReview')).recoverOutlineReviews();
  await ensureClientId();
  await seedProvidersFromEnv();
  await useSettings.getState().load();
  applyTheme(useSettings.getState().settings.theme);
  wireJobsStore();
  // 先把云端账号读出来，社区覆盖层才知道该跟谁重置。
  await useAccount.getState().refresh();
  watchAccountForCommunity();
  await startAssistantRuntime();
  await startJobRunner();
  await useJobs.getState().loadAll();
  // 回收站过期清理（30 天）+ 孤儿 PDF 清理；后台跑，失败只记日志，不阻断启动。
  void runStartupMaintenance().then((r) => {
    if (r.purgedNovels || r.purgedDocuments || r.removedOrphans.length) {
      console.info('[maintenance] 已清理', r.purgedNovels, '本小说、', r.purgedDocuments, '份文档、', r.removedOrphans.length, '个孤儿文件');
    }
    if (r.failures.length) console.warn('[maintenance] 部分清理失败：', r.failures);
  });
}
