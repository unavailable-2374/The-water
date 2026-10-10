import { ActivityStatus } from '@/components/Activity';
import { Button } from '@/components/ui';
import { t } from '@/i18n';

/** Failed loading must stop animating and offer an actual retry. */
export function AsyncNotice({ error, retry }: { error?: unknown; retry: () => void }) {
  return <div className="flex h-full min-h-32 items-center justify-center gap-3 p-8 text-sm text-ink-400">
    {error != null ? <div role="alert" className="space-y-3 text-cinnabar-600 dark:text-cinnabar-100">
      <p>{error instanceof Error ? error.message : String(error)}</p>
      <Button onClick={retry}>{t.common.retry}</Button>
    </div> : <ActivityStatus label={t.common.loading} />}
  </div>;
}
