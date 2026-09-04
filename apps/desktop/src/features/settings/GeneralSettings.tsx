import { t } from '@/i18n/zh';
import { Card, Field, SectionTitle, Select } from '@/components/ui';
import { useSettings } from '@/stores/settingsStore';

export function GeneralSettings() {
  const { settings, providers, update } = useSettings();
  const purposeSelect = (key: 'chat' | 'writing' | 'planning', label: string) => (
    <Field label={label}>
      <Select value={settings.defaultProviderId[key] ?? ''} onChange={(e) => update({ defaultProviderId: { ...settings.defaultProviderId, [key]: e.target.value || null } })}>
        <option value="">（跟随默认供应商）</option>
        {providers.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}
      </Select>
    </Field>
  );
  return (
    <div className="max-w-xl space-y-6">
      <header>
        <h1 className="font-serif text-2xl font-semibold tracking-wide">{t.settings.general}</h1>
        <p className="mt-1 text-sm text-ink-500">决定不同场景下，由哪个模型来陪你。</p>
      </header>
      <Card>
        <SectionTitle>各场景使用的模型</SectionTitle>
        <div className="space-y-4">
          {purposeSelect('chat', t.settings.purposeChat)}
          {purposeSelect('writing', t.settings.purposeWriting)}
          {purposeSelect('planning', t.settings.purposePlanning)}
        </div>
      </Card>
      <Card>
        <SectionTitle>写作</SectionTitle>
        <div className="space-y-4">
          <label className="flex items-center gap-2.5 text-sm text-ink-800 dark:text-paper-100">
            <input type="checkbox" className="h-4 w-4 rounded" checked={settings.autoResumeJobs} onChange={(e) => update({ autoResumeJobs: e.target.checked })} />
            {t.settings.autoResume}
          </label>
          <Field label={t.settings.countMode}>
            <Select value={settings.countMode} onChange={(e) => update({ countMode: e.target.value as 'all' | 'han' })}>
              <option value="all">{t.settings.countAll}</option>
              <option value="han">{t.settings.countHan}</option>
            </Select>
          </Field>
        </div>
      </Card>
    </div>
  );
}
