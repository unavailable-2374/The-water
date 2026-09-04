import { useEffect, useState } from 'react';
import { nanoid } from 'nanoid';
import { t } from '@/i18n/zh';
import { Button, Dialog, Field, Input, Select } from '@/components/ui';
import { toast } from '@/components/Toast';
import { createProvider, updateProvider } from '@/db/repos/providersRepo';
import { PROVIDER_PRESETS } from '@/llm/factory';
import { invalidateProvider } from '@/llm/registry';
import { providerSecretRef, secrets } from '@/secrets/keychain';
import type { JsonMode, ProviderConfig, ProviderKind } from '@/llm/types';

interface Props { open: boolean; initial: ProviderConfig | null; onClose: () => void; onSaved: () => void }

interface FormState {
  name: string; kind: ProviderKind; baseUrl: string; model: string; contextWindow: number; maxOutputTokens: number; jsonMode: JsonMode; temperature: number;
  apiKey: string; useEnv: boolean; envVar: string;
}

const blank = (): FormState => ({ name: '', kind: 'openai_compatible', baseUrl: '', model: '', contextWindow: 128000, maxOutputTokens: 8192, jsonMode: 'json_object', temperature: 0.8, apiKey: '', useEnv: false, envVar: '' });

export function ProviderForm({ open, initial, onClose, onSaved }: Props) {
  const [f, setF] = useState<FormState>(blank());
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    if (initial) {
      setF({ name: initial.name, kind: initial.kind, baseUrl: initial.baseUrl, model: initial.model, contextWindow: initial.contextWindow, maxOutputTokens: initial.maxOutputTokens, jsonMode: initial.jsonMode, temperature: initial.temperature, apiKey: '', useEnv: initial.secretRef.startsWith('env:'), envVar: initial.secretRef.startsWith('env:') ? initial.secretRef.slice(4) : '' });
    } else setF(blank());
  }, [open, initial]);

  const applyPreset = (id: string) => {
    const p = PROVIDER_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setF((s) => ({ ...s, name: s.name || p.name, kind: p.kind, baseUrl: p.baseUrl, model: p.model, contextWindow: p.contextWindow, maxOutputTokens: p.maxOutputTokens, jsonMode: p.jsonMode, envVar: p.envVar ?? '' }));
  };

  const save = async () => {
    if (!f.name.trim() || !f.baseUrl.trim() || !f.model.trim()) { toast.error('名称、Base URL、模型不能为空'); return; }
    if (!f.useEnv && !initial && !f.apiKey.trim()) { toast.error('请填写 API Key'); return; }
    if (f.useEnv && !f.envVar.trim()) { toast.error('请填写环境变量名'); return; }
    setSaving(true);
    try {
      const id = initial?.id ?? nanoid();
      const secretRef = f.useEnv ? `env:${f.envVar.trim()}` : providerSecretRef(id);
      if (!f.useEnv && f.apiKey.trim()) await secrets().set(secretRef, f.apiKey.trim());
      const base = { name: f.name.trim(), kind: f.kind, baseUrl: f.baseUrl.trim(), model: f.model.trim(), contextWindow: f.contextWindow, maxOutputTokens: f.maxOutputTokens, jsonMode: f.jsonMode, temperature: f.temperature, extraHeaders: initial?.extraHeaders ?? {}, secretRef };
      if (initial) await updateProvider(id, base);
      else await createProvider(base, id);
      invalidateProvider(id);
      toast.success('已保存');
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  return (
    <Dialog open={open} onClose={onClose} title={initial ? t.settings.editProvider : t.settings.addProvider} subtitle={initial ? '改完之后，记得再测一次连接。' : '填入接口地址、模型名和密钥，AI 就能上线了。'}>
      <div className="space-y-4">
        {!initial && (
          <Field label={t.settings.preset}>
            <Select defaultValue="" onChange={(e) => applyPreset(e.target.value)}>
              <option value="">自定义…</option>
              {PROVIDER_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label={t.settings.name}><Input value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t.settings.kind}>
            <Select value={f.kind} onChange={(e) => set('kind', e.target.value as ProviderKind)}>
              <option value="openai_compatible">OpenAI 兼容</option>
              <option value="anthropic">Anthropic</option>
            </Select>
          </Field>
          <Field label={t.settings.jsonMode}>
            <Select value={f.jsonMode} onChange={(e) => set('jsonMode', e.target.value as JsonMode)}>
              <option value="none">none（仅提示词）</option>
              <option value="json_object">json_object</option>
              <option value="json_schema">json_schema</option>
              <option value="tool">tool（Anthropic）</option>
            </Select>
          </Field>
        </div>
        <Field label={t.settings.baseUrl}><Input value={f.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder="https://api.deepseek.com" /></Field>
        <Field label={t.settings.model}><Input value={f.model} onChange={(e) => set('model', e.target.value)} placeholder="deepseek-chat" /></Field>
        <div className="grid grid-cols-3 gap-4">
          <Field label={t.settings.contextWindow}><Input type="number" value={f.contextWindow} onChange={(e) => set('contextWindow', Number(e.target.value))} /></Field>
          <Field label={t.settings.maxOutput}><Input type="number" value={f.maxOutputTokens} onChange={(e) => set('maxOutputTokens', Number(e.target.value))} /></Field>
          <Field label={t.settings.temperature}><Input type="number" step="0.1" min="0" max="2" value={f.temperature} onChange={(e) => set('temperature', Number(e.target.value))} /></Field>
        </div>
        <label className="flex items-center gap-2.5 text-sm text-ink-800 dark:text-paper-100">
          <input type="checkbox" className="h-4 w-4 rounded" checked={f.useEnv} onChange={(e) => set('useEnv', e.target.checked)} />
          {t.settings.apiKeyFromEnv}
        </label>
        {f.useEnv ? (
          <Field label="环境变量名" hint="仅允许 *_API_KEY 形式；应用需在能读到该变量的终端中启动"><Input value={f.envVar} onChange={(e) => set('envVar', e.target.value.toUpperCase())} placeholder="DEEPSEEK_API_KEY" /></Field>
        ) : (
          <Field label={t.settings.apiKey} hint={initial ? '留空则保持不变。' + t.settings.apiKeyHint : t.settings.apiKeyHint}><Input type="password" value={f.apiKey} onChange={(e) => set('apiKey', e.target.value)} autoComplete="off" /></Field>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button variant="primary" onClick={save} disabled={saving}>{t.common.save}</Button>
        </div>
      </div>
    </Dialog>
  );
}
