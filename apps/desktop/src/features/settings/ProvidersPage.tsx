import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Plus, Star, Trash2, Pencil, PlugZap } from 'lucide-react';
import { fmt, t } from '@/i18n';
import { Badge, Button, EmptyState, IconButton, confirm, deleteLabel } from '@/components/ui';
import { toast } from '@/components/Toast';
import { useSettings } from '@/stores/settingsStore';
import { deleteProvider, setDefaultProvider } from '@/db/repos/providersRepo';
import { planProviderCleanup } from './providerCleanup';
import { invalidateProvider, providerFromConfig } from '@/llm/registry';
import { complete } from '@/llm/complete';
import { secrets } from '@/secrets/keychain';
import type { ProviderConfig } from '@/llm/types';
import { ProviderForm } from './ProviderForm';

export function ProvidersPage() {
  const navigate = useNavigate();
  const { providers, providerError, settings, refreshProviders, update } = useSettings();
  const [editing, setEditing] = useState<ProviderConfig | null | 'new'>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const test = async (p: ProviderConfig) => {
    setTesting(p.id);
    try {
      invalidateProvider(p.id); // re-read the key from keychain / env every time
      const provider = await providerFromConfig(p);
      const r = await complete(provider, { messages: [{ role: 'user', content: t.settings.testPrompt }], maxTokens: 20 });
      toast.success(`${t.settings.testOk}：${r.text.trim().slice(0, 40)}`);
    } catch (e) {
      toast.error(`${t.settings.testFail}：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(null);
    }
  };
  const remove = async (p: ProviderConfig) => {
    const ok = await confirm({
      title: fmt(t.settings.deleteProviderTitle, { name: p.name }),
      description: t.settings.deleteProviderDesc,
      confirmText: t.common.delete,
      tone: 'danger',
    });
    if (!ok) return;
    // 删之前先算好要连带清理什么：用途覆盖不能留着指向已删的 id，默认位也不能空着。
    const plan = planProviderCleanup({
      deleted: { id: p.id, name: p.name, isDefault: p.isDefault },
      remaining: providers.filter((x) => x.id !== p.id).map((x) => ({ id: x.id, name: x.name })),
      purposes: settings.defaultProviderId,
    });
    await secrets().delete(p.secretRef).catch(() => undefined);
    await deleteProvider(p.id);
    invalidateProvider(p.id);
    if (plan.purposes) await update({ defaultProviderId: plan.purposes });
    if (plan.promoteDefaultTo) await setDefaultProvider(plan.promoteDefaultTo);
    await refreshProviders();
    toast.info(plan.notice);
  };
  const makeDefault = async (p: ProviderConfig) => {
    await setDefaultProvider(p.id);
    await refreshProviders();
  };

  if (settings.aiServiceMode !== 'local') return (
    <div className="space-y-6">
      <h1 className="page-heading text-[28px] font-bold">{t.settings.serverService}</h1>
      <p className="text-sm text-ink-500">{t.settings.serverServiceDesc}</p>
      <p className="text-sm text-ink-500">{t.settings.serverPrivacy}</p>
      {providerError && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{providerError}</p>}
      {providers[0] && <div className="rounded-2xl bg-paper-0 p-5 shadow-soft dark:bg-paper-900">
        <p>{providers[0].name} · {providers[0].model}</p>
        <p className="mt-1 text-xs text-ink-500">{providers[0].baseUrl}</p>
      </div>}
      <div className="flex gap-3">
        <Button variant="primary" onClick={() => navigate('/settings/account')}>{t.settings.serverLogin}</Button>
        <Button onClick={async () => {
          try { await refreshProviders(); const state = useSettings.getState(); if (!state.providers.length) throw new Error(state.providerError || t.settings.serverUnavailable); }
          catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
        }}>{t.settings.serverRefresh}</Button>
      </div>
      <Button variant="ghost" onClick={() => update({ aiServiceMode: 'local' })}>{t.settings.localMode}</Button>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 text-sm text-ink-500">
        <p>{t.settings.localModeDesc}</p>
        <Button onClick={() => update({ aiServiceMode: 'server' })}>{t.settings.serverMode}</Button>
      </div>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="page-heading text-[28px] font-bold">{t.settings.providers}</h1>
          <p className="mt-1 text-sm text-ink-500">{t.settings.providersDesc}</p>
        </div>
        <Button variant="primary" onClick={() => setEditing('new')}><Plus size={16} strokeWidth={1.75} aria-hidden="true" />{t.settings.addProvider}</Button>
      </header>
      {providers.length === 0 ? (
        <EmptyState
          icon={<PlugZap size={40} strokeWidth={1.25} aria-hidden="true" />}
          title={t.settings.providersEmptyTitle}
          description={t.settings.providersEmptyDesc}
          action={<Button variant="primary" onClick={() => setEditing('new')}>{t.settings.addProvider}</Button>}
        />
      ) : (
        <ul className="space-y-3" aria-label={t.settings.providerList}>
          {providers.map((p) => (
            <li key={p.id} className="flex items-center gap-4 rounded-2xl bg-paper-0 p-5 shadow-soft transition hover:shadow-lift dark:bg-paper-900">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-serif text-base font-semibold tracking-wide text-ink-900 dark:text-paper-100">{p.name}</span>
                  {p.isDefault && <Badge tone="ai" dot>{t.settings.isDefault}</Badge>}
                  <Badge>{p.kind === 'anthropic' ? 'Anthropic' : t.settings.kindOpenAi}</Badge>
                  {p.secretRef.startsWith('env:') && <Badge tone="amber">{p.secretRef}</Badge>}
                </div>
                <div className="mt-1 truncate text-xs text-ink-500">{p.model} · {p.baseUrl} · <span className="font-serif">{p.contextWindow.toLocaleString()}</span> {t.settings.contextLabel}</div>
              </div>
              <Button size="sm" variant="ai" onClick={() => test(p)} disabled={testing === p.id}><PlugZap size={16} strokeWidth={1.75} aria-hidden="true" />{testing === p.id ? t.settings.testing : t.settings.testConnection}</Button>
              {!p.isDefault && <IconButton label={t.settings.setDefault} onClick={() => makeDefault(p)}><Star size={16} strokeWidth={1.75} aria-hidden="true" /></IconButton>}
              <IconButton label={t.common.edit} onClick={() => setEditing(p)}><Pencil size={16} strokeWidth={1.75} aria-hidden="true" /></IconButton>
              <IconButton label={deleteLabel(p.name)} className="hover:text-cinnabar-600" onClick={() => remove(p)}><Trash2 size={16} strokeWidth={1.75} aria-hidden="true" /></IconButton>
            </li>
          ))}
        </ul>
      )}
      <ProviderForm open={editing !== null} initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await refreshProviders(); }} />
    </div>
  );
}
