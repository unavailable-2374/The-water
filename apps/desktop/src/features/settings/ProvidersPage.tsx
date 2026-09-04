import { useState } from 'react';
import { Plus, Star, Trash2, Pencil, PlugZap } from 'lucide-react';
import { t } from '@/i18n/zh';
import { Badge, Button, EmptyState } from '@/components/ui';
import { toast } from '@/components/Toast';
import { useSettings } from '@/stores/settingsStore';
import { deleteProvider, setDefaultProvider } from '@/db/repos/providersRepo';
import { invalidateProvider, providerFromConfig } from '@/llm/registry';
import { complete } from '@/llm/complete';
import { secrets } from '@/secrets/keychain';
import type { ProviderConfig } from '@/llm/types';
import { ProviderForm } from './ProviderForm';

export function ProvidersPage() {
  const { providers, refreshProviders } = useSettings();
  const [editing, setEditing] = useState<ProviderConfig | null | 'new'>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const test = async (p: ProviderConfig) => {
    setTesting(p.id);
    try {
      invalidateProvider(p.id); // re-read the key from keychain / env every time
      const provider = await providerFromConfig(p);
      const r = await complete(provider, { messages: [{ role: 'user', content: '请只回复两个字：你好' }], maxTokens: 20 });
      toast.success(`${t.settings.testOk}：${r.text.trim().slice(0, 40)}`);
    } catch (e) {
      toast.error(`${t.settings.testFail}：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(null);
    }
  };
  const remove = async (p: ProviderConfig) => {
    if (!confirm(t.common.confirmDelete)) return;
    await secrets().delete(p.secretRef).catch(() => undefined);
    await deleteProvider(p.id);
    invalidateProvider(p.id);
    await refreshProviders();
  };
  const makeDefault = async (p: ProviderConfig) => {
    await setDefaultProvider(p.id);
    await refreshProviders();
  };

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-6">
        <div>
          <h1 className="font-serif text-2xl font-semibold tracking-wide">{t.settings.providers}</h1>
          <p className="mt-1 text-sm text-ink-500">接入一个模型，AI 才能陪你读书、替你写稿。</p>
        </div>
        <Button variant="primary" onClick={() => setEditing('new')}><Plus size={16} strokeWidth={1.75} />{t.settings.addProvider}</Button>
      </header>
      {providers.length === 0 ? (
        <EmptyState
          icon={<PlugZap size={40} strokeWidth={1.25} />}
          title="还没有接入任何模型"
          description="添加一个模型供应商（DeepSeek、OpenAI 兼容接口或 Anthropic），之后就能和 AI 一起阅读、写作。"
          action={<Button variant="primary" onClick={() => setEditing('new')}>{t.settings.addProvider}</Button>}
        />
      ) : (
        <ul className="space-y-3">
          {providers.map((p) => (
            <li key={p.id} className="flex items-center gap-4 rounded-2xl bg-paper-0 p-5 shadow-soft transition hover:shadow-lift dark:bg-paper-900">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-serif text-base font-semibold tracking-wide text-ink-900 dark:text-paper-100">{p.name}</span>
                  {p.isDefault && <Badge tone="ai" dot>{t.settings.isDefault}</Badge>}
                  <Badge>{p.kind === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'}</Badge>
                  {p.secretRef.startsWith('env:') && <Badge tone="amber">{p.secretRef}</Badge>}
                </div>
                <div className="mt-1 truncate text-xs text-ink-500">{p.model} · {p.baseUrl} · <span className="font-serif">{p.contextWindow.toLocaleString()}</span> 上下文</div>
              </div>
              <Button size="sm" variant="ai" onClick={() => test(p)} disabled={testing === p.id}><PlugZap size={16} strokeWidth={1.75} />{testing === p.id ? t.settings.testing : t.settings.testConnection}</Button>
              {!p.isDefault && <Button size="sm" variant="ghost" onClick={() => makeDefault(p)} title={t.settings.setDefault}><Star size={16} strokeWidth={1.75} /></Button>}
              <Button size="sm" variant="ghost" onClick={() => setEditing(p)} title={t.common.edit}><Pencil size={16} strokeWidth={1.75} /></Button>
              <Button size="sm" variant="ghost" className="hover:text-cinnabar-600" onClick={() => remove(p)} title={t.common.delete}><Trash2 size={16} strokeWidth={1.75} /></Button>
            </li>
          ))}
        </ul>
      )}
      <ProviderForm open={editing !== null} initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await refreshProviders(); }} />
    </div>
  );
}
