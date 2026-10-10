/**
 * 按用途选模型（§2.1 第 2 条）的选择器。
 *
 * 创建向导第三步（i18n 里早就叫「模型与确认」，但一直没有模型可选）和规划页
 * 都用它。选择结果按小说存在设置里，建任务时冻结进任务参数。
 */
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button, Field, Select, cn } from '@/components/ui';
import { t } from '@/i18n';
import { useSettings } from '@/stores/settingsStore';
import { STEP_PURPOSES, STEP_PURPOSE_HINTS, STEP_PURPOSE_LABELS, cleanProviderMap, type StepPurpose, type StepProviderMap } from '@/jobs/purposes';

/** 展开前先露出这两档：一贵一便宜，够大多数人用了。 */
const PRIMARY: readonly StepPurpose[] = ['writing', 'planning'];

export function ModelPurposePicker({ value, onChange, className }: { value: StepProviderMap; onChange: (next: StepProviderMap) => void; className?: string }) {
  const providers = useSettings((s) => s.providers);
  const mode = useSettings((s) => s.settings.aiServiceMode);
  const providerError = useSettings((s) => s.providerError);
  const refreshProviders = useSettings((s) => s.refreshProviders);
  const [checking, setChecking] = useState(false);
  const checkConnection = async () => {
    setChecking(true);
    try { await refreshProviders(); } finally { setChecking(false); }
  };
  useEffect(() => { void refreshProviders(); }, [refreshProviders]);
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? STEP_PURPOSES : PRIMARY;
  const set = (p: StepPurpose, id: string) => onChange(cleanProviderMap({ ...value, [p]: id || null }));

  if (providers.length === 0) {
    return <div className={className}>
      <p className="text-xs text-amber-700 dark:text-amber-300" role="alert">{providerError || (mode === 'server' ? t.settings.serverUnavailable : t.studio.models.noProvider)}</p>
      <Button className="mt-2" disabled={checking} onClick={() => void checkConnection()}>{checking ? t.common.processing : t.common.retry}</Button>
    </div>;
  }
  return (
    <div className={cn('space-y-4', className)}>
      <div className="grid grid-cols-2 gap-4">
        {shown.map((p) => (
          <Field key={p} label={STEP_PURPOSE_LABELS[p]} hint={STEP_PURPOSE_HINTS[p]}>
            <Select value={value[p] ?? ''} onChange={(e) => set(p, e.target.value)}>
              <option value="">{t.studio.models.followDefault}</option>
              {providers.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.model}</option>)}
            </Select>
          </Field>
        ))}
      </div>
      <button type="button" aria-expanded={expanded} className="flex items-center gap-1 text-xs text-ink-500 hover:text-ink-800 dark:hover:text-paper-100" onClick={() => setExpanded((v) => !v)}>
        {expanded ? <ChevronDown size={13} strokeWidth={1.75} aria-hidden="true" /> : <ChevronRight size={13} strokeWidth={1.75} aria-hidden="true" />}
        {expanded ? t.studio.models.collapse : t.studio.models.expand}
      </button>
    </div>
  );
}
