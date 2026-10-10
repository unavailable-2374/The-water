import { useEffect, useState } from 'react';
import { Button, Dialog } from '@/components/ui';
import { t } from '@/i18n';
import { AssistantPanel } from './AssistantPanel';
import { useAssistant } from './runtime';
export function AssistantDock() {
  const open = useAssistant((s) => s.open),
    setOpen = useAssistant((s) => s.setOpen);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1100px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1100px)');
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  if (narrow)
    return (
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t.assistant.title}
        width="max-w-md"
        placement="right"
      >
        <AssistantPanel compact />
      </Dialog>
    );
  if (!open) return null;
  return (
    <aside className="flex h-full w-[380px] min-w-[320px] shrink-0 flex-col border-l border-paper-300 bg-paper-50 dark:border-paper-800 dark:bg-paper-950">
      <Button size="sm" onClick={() => setOpen(false)}>
        {t.assistant.close}
      </Button>
      <div className="min-h-0 flex-1">
        <AssistantPanel compact />
      </div>
    </aside>
  );
}
