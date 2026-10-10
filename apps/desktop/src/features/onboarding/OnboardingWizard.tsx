import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { nanoid } from 'nanoid';
import { BookOpen, Check, ExternalLink, Feather, PlugZap, X } from 'lucide-react';
import { t, fmt } from '@/i18n';
import { Button, Dialog, Field, Input, Spinner, cn, confirm } from '@/components/ui';
import { toast } from '@/components/Toast';
import { PROVIDER_PRESETS, getPreset } from '@/llm/factory';
import { invalidateProvider, providerFromConfig } from '@/llm/registry';
import { complete } from '@/llm/complete';
import { providerSecretRef, secrets } from '@/secrets/keychain';
import { createProvider } from '@/db/repos/providersRepo';
import { setSetting } from '@/db/repos/settingsRepo';
import { useSettings } from '@/stores/settingsStore';
import type { ProviderConfig } from '@/llm/types';
import {
  ONBOARDING_DONE_KEY, WIZARD_STEPS,
  canAdvance, canGoBack, initialOnboardingState, onboardingReducer, stepIndex, type OnboardingStep,
} from './steps';

/** 步骤名：渲染时现取，不要拷成模块顶层常量表（切语言就不跟着变了）。 */
function stepLabel(step: OnboardingStep): string {
  const labels: Record<OnboardingStep, string> = {
    provider: t.onboarding.stepProvider, key: t.onboarding.stepKey, test: t.onboarding.stepTest, done: '',
  };
  return labels[step];
}

/** 进度条：三个圆点 + 步骤名。 */
function Steps({ current }: { current: number }) {
  const total = WIZARD_STEPS.length;
  return (
    <ol aria-label={t.onboarding.stepsLabel} className="mb-6 flex items-center gap-2 text-xs">
      {WIZARD_STEPS.map((step, i) => {
        const label = stepLabel(step);
        return (
          <li
            key={step}
            className="flex items-center gap-2"
            aria-current={i === current ? 'step' : undefined}
            aria-label={fmt(t.onboarding.stepOf, { index: i + 1, total, label })}
          >
            <span aria-hidden="true" className={cn(
              'flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-medium',
              i < current ? 'bg-tea-600 text-paper-0' : i === current ? 'bg-accent-600 text-white' : 'bg-paper-200 text-ink-400 dark:bg-paper-800',
            )}>
              {i < current ? <Check size={12} strokeWidth={2.5} /> : i + 1}
            </span>
            <span aria-hidden="true" className={i === current ? 'font-medium text-ink-800 dark:text-paper-100' : 'text-ink-400'}>{label}</span>
            {i < total - 1 && <span aria-hidden="true" className="mx-1 h-px w-6 bg-paper-300 dark:bg-paper-800" />}
          </li>
        );
      })}
    </ol>
  );
}

/** 首启引导：选供应商 → 填 Key → 测试连接 → 引导第一件事。 */
export function OnboardingWizard({ onClose }: { onClose: () => void }) {
  const [s, dispatch] = useReducer(onboardingReducer, initialOnboardingState);
  const [showKey, setShowKey] = useState(false);
  const navigate = useNavigate();
  // StrictMode 下 effect 会跑两次，防止同一次测试发两个请求。
  const inFlight = useRef(false);
  const refreshProviders = useSettings((st) => st.refreshProviders);

  const finish = useCallback(async () => {
    await setSetting(ONBOARDING_DONE_KEY, true);
    onClose();
  }, [onClose]);

  const skip = useCallback(async () => {
    const ok = await confirm({ title: t.onboarding.skipConfirmTitle, description: t.onboarding.skipConfirmDesc, confirmText: t.onboarding.skip });
    if (ok) await finish();
  }, [finish]);

  /** 真发一次最小请求；通过之后才把供应商写库。 */
  const runTest = useCallback(async () => {
    if (inFlight.current || !s.presetId) return;
    inFlight.current = true;
    dispatch({ type: 'testStart' });
    const preset = getPreset(s.presetId);
    const id = nanoid();
    const secretRef = providerSecretRef(id);
    const stamp = Date.now();
    const draft: ProviderConfig = {
      id, name: preset.name, kind: preset.kind, baseUrl: preset.baseUrl, model: preset.model,
      contextWindow: preset.contextWindow, maxOutputTokens: preset.maxOutputTokens, jsonMode: preset.jsonMode,
      temperature: 0.8, extraHeaders: {}, secretRef, isDefault: true, createdAt: stamp, updatedAt: stamp,
    };
    try {
      await secrets().set(secretRef, s.apiKey.trim());
      invalidateProvider(id);
      const provider = await providerFromConfig(draft);
      await complete(provider, { messages: [{ role: 'user', content: '请只回复两个字：你好' }], maxTokens: 20 });
      await createProvider({
        name: draft.name, kind: draft.kind, baseUrl: draft.baseUrl, model: draft.model,
        contextWindow: draft.contextWindow, maxOutputTokens: draft.maxOutputTokens, jsonMode: draft.jsonMode,
        temperature: draft.temperature, extraHeaders: {}, secretRef, isDefault: true,
      }, id);
      invalidateProvider(id);
      await refreshProviders();
      dispatch({ type: 'testOk', providerId: id });
    } catch (e) {
      // 没通过就不留垃圾：钥匙串里的临时 Key 删掉，库里本来也没写。
      await secrets().delete(secretRef).catch(() => undefined);
      invalidateProvider(id);
      dispatch({ type: 'testFail', message: e instanceof Error ? e.message : String(e) });
    } finally {
      inFlight.current = false;
    }
  }, [s.presetId, s.apiKey, refreshProviders]);

  // 进到第三步就自动跑一次，少点一下。
  useEffect(() => {
    if (s.step === 'test' && s.test === 'idle') void runTest();
  }, [s.step, s.test, runTest]);

  const goTo = async (path: string, hint?: string) => {
    await finish();
    if (hint) toast.info(hint);
    navigate(path);
  };

  const preset = s.presetId ? getPreset(s.presetId) : null;

  return (
    <Dialog open title={t.onboarding.title} subtitle={t.onboarding.subtitle} width="max-w-xl" onClose={() => void skip()}>
      {s.step !== 'done' && <Steps current={stepIndex(s.step)} />}

      {s.step === 'provider' && (
        <div className="space-y-3">
          <p className="text-sm text-ink-500">{t.onboarding.pickHint}</p>
          <ul aria-label={t.onboarding.providerListLabel} className="space-y-2">
            {PROVIDER_PRESETS.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  aria-pressed={s.presetId === p.id}
                  onClick={() => dispatch({ type: 'selectPreset', presetId: p.id })}
                  className={cn(
                    'w-full rounded-2xl px-4 py-3 text-left transition ring-1',
                    s.presetId === p.id
                      ? 'bg-tea-50 ring-tea-500 dark:bg-tea-800/30'
                      : 'bg-paper-0 ring-paper-300/70 hover:bg-paper-100 dark:bg-paper-900 dark:ring-paper-800 dark:hover:bg-paper-800',
                  )}
                >
                  <div className="font-serif text-sm font-semibold tracking-wide">{p.name}</div>
                  <div className="mt-0.5 text-xs text-ink-500">{fmt(t.onboarding.presetMeta, { model: p.model, context: p.contextWindow.toLocaleString() })}</div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {s.step === 'key' && preset && (
        <div className="space-y-4">
          <p className="text-sm text-ink-500">{fmt(t.onboarding.keyFor, { name: preset.name })}</p>
          {preset.apiKeyUrl && (
            <Button variant="secondary" onClick={() => void openKeyPage(preset.apiKeyUrl!)}>
              <ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" />{t.onboarding.getKey}
            </Button>
          )}
          <Field label={t.onboarding.keyLabel} hint={t.onboarding.keyHint}>
            <Input
              type={showKey ? 'text' : 'password'}
              value={s.apiKey}
              autoComplete="off"
              autoFocus
              placeholder="sk-…"
              onChange={(e) => dispatch({ type: 'setKey', apiKey: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter' && canAdvance(s)) dispatch({ type: 'next' }); }}
            />
          </Field>
          <label className="flex items-center gap-2.5 text-sm text-ink-600 dark:text-ink-300">
            <input type="checkbox" className="h-4 w-4 rounded" checked={showKey} onChange={(e) => setShowKey(e.target.checked)} />
            {t.onboarding.showKey}
          </label>
        </div>
      )}

      {s.step === 'test' && (
        <div className="space-y-4">
          <p className="text-sm text-ink-500">{t.onboarding.testHint}</p>
          {s.test === 'running' && (
            <div role="status" className="flex items-center gap-2.5 rounded-2xl bg-paper-100 px-4 py-3 text-sm text-ink-600 dark:bg-paper-950 dark:text-ink-300">
              <Spinner />{t.onboarding.testRunning}
            </div>
          )}
          {s.test === 'ok' && (
            <div role="status" className="flex items-center gap-2.5 rounded-2xl bg-tea-50 px-4 py-3 text-sm text-tea-700 dark:bg-tea-800/30 dark:text-tea-200">
              <Check size={16} strokeWidth={2} aria-hidden="true" />{t.onboarding.testOk}
            </div>
          )}
          {s.test === 'fail' && (
            <div role="alert" className="rounded-2xl bg-cinnabar-50 px-4 py-3 text-sm text-cinnabar-700 dark:bg-cinnabar-700/25 dark:text-cinnabar-100">
              <div className="flex items-center gap-2.5 font-medium"><X size={16} strokeWidth={2} aria-hidden="true" />{t.onboarding.testFail}</div>
              <p className="mt-1 whitespace-pre-wrap break-all text-xs leading-relaxed">{s.testError}</p>
            </div>
          )}
        </div>
      )}

      {s.step === 'done' && (
        <div className="space-y-3">
          <p className="font-serif text-base text-ink-800 dark:text-paper-100">{t.onboarding.doneTitle}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <button type="button" onClick={() => void goTo('/library', t.onboarding.importHint)} className="rounded-2xl bg-paper-0 p-5 text-left shadow-soft transition hover:shadow-lift dark:bg-paper-900">
              <BookOpen size={22} strokeWidth={1.5} className="text-tea-600" aria-hidden="true" />
              <div className="mt-2 font-serif text-sm font-semibold tracking-wide">{t.onboarding.doneImport}</div>
              <div className="mt-1 text-xs leading-relaxed text-ink-500">{t.onboarding.doneImportDesc}</div>
            </button>
            <button type="button" onClick={() => void goTo('/studio/new')} className="rounded-2xl bg-paper-0 p-5 text-left shadow-soft transition hover:shadow-lift dark:bg-paper-900">
              <Feather size={22} strokeWidth={1.5} className="text-cinnabar-600" aria-hidden="true" />
              <div className="mt-2 font-serif text-sm font-semibold tracking-wide">{t.onboarding.doneNovel}</div>
              <div className="mt-1 text-xs leading-relaxed text-ink-500">{t.onboarding.doneNovelDesc}</div>
            </button>
          </div>
        </div>
      )}

      <div className="mt-6 flex items-center justify-between gap-2">
        <Button variant="ghost" onClick={() => void skip()}>{t.onboarding.skip}</Button>
        <div className="flex gap-2">
          {canGoBack(s) && <Button variant="ghost" onClick={() => dispatch({ type: 'back' })}>{t.studio.wizard.prev}</Button>}
          {s.step === 'test' && s.test === 'fail' && (
            <Button variant="secondary" onClick={() => void runTest()}><PlugZap size={16} strokeWidth={1.75} aria-hidden="true" />{t.onboarding.testRetry}</Button>
          )}
          {s.step !== 'done' && (
            <Button variant="primary" disabled={!canAdvance(s)} onClick={() => dispatch({ type: 'next' })}>{t.studio.wizard.next}</Button>
          )}
          {s.step === 'done' && <Button variant="ghost" onClick={() => void finish()}>{t.common.close}</Button>}
        </div>
      </div>
    </Dialog>
  );
}

/** capabilities 里的 `opener:default` 允许 https 外链，够用。 */
async function openKeyPage(url: string): Promise<void> {
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url).catch((e: unknown) => {
    toast.error(fmt(t.onboarding.openFailed, { message: e instanceof Error ? e.message : String(e) }));
  });
}
