import { useEffect, useState } from 'react';
import { nanoid } from 'nanoid';
import { t } from '@/i18n';
import { Button, Dialog, Field, Input, Select, Textarea } from '@/components/ui';
import { toast } from '@/components/Toast';
import { createProvider, updateProvider, type ProviderInput } from '@/db/repos/providersRepo';
import { PROVIDER_PRESETS, findPresetForModel, modelParams, type PresetId } from '@/llm/factory';
import { invalidateProvider } from '@/llm/registry';
import { providerSecretRef, secrets } from '@/secrets/keychain';
import type { JsonMode, ProviderConfig, ProviderKind } from '@/llm/types';
import {
  RUNTIME_DEFAULTS, formatHeaders, msToSeconds, parseHeaders, secondsToMs,
  validateBaseUrl, validateRuntimeFields, type RuntimeFields,
} from './providerAdvanced';

interface Props { open: boolean; initial: ProviderConfig | null; onClose: () => void; onSaved: () => void }

interface FormState extends RuntimeFields {
  /** '' 表示自定义（非预设）供应商。 */
  presetId: string;
  name: string; kind: ProviderKind; baseUrl: string; model: string; contextWindow: number; maxOutputTokens: number; jsonMode: JsonMode; temperature: number;
  apiKey: string; useEnv: boolean; envVar: string; headersText: string;
}

const blank = (): FormState => ({
  presetId: '', name: '', kind: 'openai_compatible', baseUrl: '', model: '', contextWindow: 128000, maxOutputTokens: 8192,
  jsonMode: 'json_object', temperature: 0.8, apiKey: '', useEnv: false, envVar: '', headersText: '', ...RUNTIME_DEFAULTS,
});

/** 运行时四列（迁移 0004）：没值就回落到默认。 */
function runtimeOf(p: ProviderConfig): RuntimeFields {
  return {
    firstByteTimeoutMs: p.firstByteTimeoutMs ?? RUNTIME_DEFAULTS.firstByteTimeoutMs,
    idleTimeoutMs: p.idleTimeoutMs ?? RUNTIME_DEFAULTS.idleTimeoutMs,
    proxyUrl: p.proxyUrl ?? RUNTIME_DEFAULTS.proxyUrl,
    concurrency: p.concurrency ?? RUNTIME_DEFAULTS.concurrency,
  };
}

export function ProviderForm({ open, initial, onClose, onSaved }: Props) {
  const [f, setF] = useState<FormState>(blank());
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    if (initial) {
      setF({
        presetId: findPresetForModel(initial.model)?.id ?? '',
        name: initial.name, kind: initial.kind, baseUrl: initial.baseUrl, model: initial.model, contextWindow: initial.contextWindow,
        maxOutputTokens: initial.maxOutputTokens, jsonMode: initial.jsonMode, temperature: initial.temperature, apiKey: '',
        useEnv: initial.secretRef.startsWith('env:'), envVar: initial.secretRef.startsWith('env:') ? initial.secretRef.slice(4) : '',
        headersText: formatHeaders(initial.extraHeaders), ...runtimeOf(initial),
      });
    } else setF(blank());
  }, [open, initial]);

  const applyPreset = (id: string) => {
    const p = PROVIDER_PRESETS.find((x) => x.id === id);
    if (!p) { setF((s) => ({ ...s, presetId: '' })); return; }
    setF((s) => ({
      ...s, presetId: p.id, name: s.name || p.name, kind: p.kind, baseUrl: p.baseUrl, model: p.model,
      contextWindow: p.contextWindow, maxOutputTokens: p.maxOutputTokens, jsonMode: p.jsonMode, envVar: p.envVar ?? '',
    }));
  };

  /** 换模型时把上下文窗口 / 输出上限同步成该模型的权威值。 */
  const applyModel = (model: string) => {
    setF((s) => {
      const params = modelParams(model, (s.presetId || undefined) as PresetId | undefined);
      return params
        ? { ...s, model, contextWindow: params.contextWindow, maxOutputTokens: params.maxOutputTokens }
        : { ...s, model };
    });
  };

  const save = async () => {
    if (!f.name.trim() || !f.model.trim()) { toast.error(t.settings.nameModelRequired); return; }
    const baseUrlError = validateBaseUrl(f.baseUrl);
    if (baseUrlError) { toast.error(baseUrlError); return; }
    if (!f.useEnv && !initial && !f.apiKey.trim()) { toast.error(t.settings.apiKeyRequired); return; }
    if (f.useEnv && !f.envVar.trim()) { toast.error(t.settings.envVarRequired); return; }
    const { headers, errors: headerErrors } = parseHeaders(f.headersText);
    const runtimeErrors = validateRuntimeFields(f);
    const problems = [...headerErrors, ...runtimeErrors];
    if (problems.length > 0) { toast.error(problems[0]!); return; }
    setSaving(true);
    try {
      const id = initial?.id ?? nanoid();
      const secretRef = f.useEnv ? `env:${f.envVar.trim()}` : providerSecretRef(id);
      if (!f.useEnv && f.apiKey.trim()) await secrets().set(secretRef, f.apiKey.trim());
      // 四个运行时字段按目标形态写；providersRepo 的类型补齐后这个断言可以去掉。
      const base = {
        name: f.name.trim(), kind: f.kind, baseUrl: f.baseUrl.trim(), model: f.model.trim(), contextWindow: f.contextWindow,
        maxOutputTokens: f.maxOutputTokens, jsonMode: f.jsonMode, temperature: f.temperature, extraHeaders: headers, secretRef,
        firstByteTimeoutMs: f.firstByteTimeoutMs, idleTimeoutMs: f.idleTimeoutMs, proxyUrl: f.proxyUrl.trim(), concurrency: f.concurrency,
      } satisfies ProviderInput;
      if (initial) await updateProvider(id, base);
      else await createProvider(base, id);
      invalidateProvider(id);
      toast.success(t.settings.saved);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  const preset = PROVIDER_PRESETS.find((p) => p.id === f.presetId);
  // 认得出模型才锁：预设里没有的模型（用户自己填的）仍然手填。
  const locked = !!preset?.lockContextWindow && !!modelParams(f.model, preset.id);

  return (
    <Dialog open={open} onClose={onClose} title={initial ? t.settings.editProvider : t.settings.addProvider} subtitle={initial ? t.settings.editProviderHint : t.settings.addProviderHint}>
      <div className="space-y-4">
        <Field label={t.settings.preset}>
          <Select value={f.presetId} onChange={(e) => applyPreset(e.target.value)}>
            <option value="">{t.settings.presetCustom}</option>
            {PROVIDER_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label={t.settings.name}><Input value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t.settings.kind}>
            <Select value={f.kind} onChange={(e) => set('kind', e.target.value as ProviderKind)}>
              <option value="openai_compatible">{t.settings.kindOpenAi}</option>
              <option value="anthropic">{t.settings.kindAnthropic}</option>
            </Select>
          </Field>
          <Field label={t.settings.jsonMode} hint={t.settings.jsonModeHint}>
            <Select value={f.jsonMode} onChange={(e) => set('jsonMode', e.target.value as JsonMode)}>
              <option value="none">{t.settings.jsonModeNone}</option>
              <option value="json_object">{t.settings.jsonModeObject}</option>
              <option value="json_schema">{t.settings.jsonModeSchema}</option>
              <option value="tool">{t.settings.jsonModeTool}</option>
            </Select>
          </Field>
        </div>
        <Field label={t.settings.baseUrl} hint={t.settings.baseUrlHint}><Input value={f.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder="https://api.deepseek.com" /></Field>
        <Field label={t.settings.model} hint={locked ? t.settings.modelLocked : undefined}>
          {preset ? (
            <Select value={f.model} onChange={(e) => applyModel(e.target.value)}>
              {preset.models.map((m) => <option key={m.model} value={m.model}>{m.label ?? m.model}</option>)}
            </Select>
          ) : (
            <Input value={f.model} onChange={(e) => applyModel(e.target.value)} placeholder="deepseek-chat" />
          )}
        </Field>
        <div className="grid grid-cols-3 gap-4">
          <Field label={t.settings.contextWindow} hint={locked ? t.settings.autoByModel : undefined}>
            <Input type="number" value={f.contextWindow} readOnly={locked} disabled={locked} onChange={(e) => set('contextWindow', Number(e.target.value))} />
          </Field>
          <Field label={t.settings.maxOutput} hint={locked ? t.settings.autoByModel : undefined}>
            <Input type="number" value={f.maxOutputTokens} readOnly={locked} disabled={locked} onChange={(e) => set('maxOutputTokens', Number(e.target.value))} />
          </Field>
          <Field label={t.settings.temperature}><Input type="number" step="0.1" min="0" max="2" value={f.temperature} onChange={(e) => set('temperature', Number(e.target.value))} /></Field>
        </div>
        <label className="flex items-center gap-2.5 text-sm text-ink-800 dark:text-paper-100">
          <input type="checkbox" className="h-4 w-4 rounded" checked={f.useEnv} onChange={(e) => set('useEnv', e.target.checked)} />
          {t.settings.apiKeyFromEnv}
        </label>
        {f.useEnv ? (
          <Field label={t.settings.envVar} hint={t.settings.envVarHint}><Input value={f.envVar} onChange={(e) => set('envVar', e.target.value.toUpperCase())} placeholder="DEEPSEEK_API_KEY" /></Field>
        ) : (
          <Field label={t.settings.apiKey} hint={initial ? t.settings.apiKeyKeepHint + t.settings.apiKeyHint : t.settings.apiKeyHint}><Input type="password" value={f.apiKey} onChange={(e) => set('apiKey', e.target.value)} autoComplete="off" /></Field>
        )}

        <details className="rounded-2xl bg-paper-100/60 px-4 py-3 dark:bg-paper-950/60">
          <summary className="cursor-pointer text-sm font-medium text-ink-700 dark:text-paper-100">{t.settings.advanced}</summary>
          <p className="mt-1 text-xs text-ink-400">{t.settings.advancedHint}</p>
          <div className="mt-4 space-y-4">
            <Field label={t.settings.extraHeaders} hint={t.settings.extraHeadersHint}>
              <Textarea rows={3} value={f.headersText} onChange={(e) => set('headersText', e.target.value)} placeholder={'X-Gateway-Token: abc123\nHTTP-Referer: https://example.com'} />
            </Field>
            <Field label={t.settings.proxyUrl} hint={t.settings.proxyHint}>
              <Input value={f.proxyUrl} onChange={(e) => set('proxyUrl', e.target.value)} placeholder="http://127.0.0.1:7890" />
            </Field>
            <div className="grid grid-cols-3 gap-4">
              <Field label={t.settings.firstByteTimeout} hint={t.settings.firstByteTimeoutHint}>
                <Input type="number" min="5" step="5" value={msToSeconds(f.firstByteTimeoutMs)} onChange={(e) => set('firstByteTimeoutMs', secondsToMs(Number(e.target.value)))} />
              </Field>
              <Field label={t.settings.idleTimeout} hint={t.settings.idleTimeoutHint}>
                <Input type="number" min="5" step="5" value={msToSeconds(f.idleTimeoutMs)} onChange={(e) => set('idleTimeoutMs', secondsToMs(Number(e.target.value)))} />
              </Field>
              <Field label={t.settings.concurrency} hint={t.settings.concurrencyHint}>
                <Input type="number" min="1" max="16" value={f.concurrency} onChange={(e) => set('concurrency', Number(e.target.value))} />
              </Field>
            </div>
          </div>
        </details>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button variant="primary" onClick={save} disabled={saving}>{t.common.save}</Button>
        </div>
      </div>
    </Dialog>
  );
}
