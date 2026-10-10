import { useNavigate } from 'react-router';
import { Button, Dialog } from '@/components/ui';
import { t } from '@/i18n';
import { setSetting } from '@/db/repos/settingsRepo';
import { ONBOARDING_DONE_KEY } from './steps';

export function ServerOnboarding({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const close = async () => { await setSetting(ONBOARDING_DONE_KEY, true); onClose(); };
  return <Dialog open title={t.settings.serverService} onClose={() => void close()}>
    <p className="text-sm text-ink-500">{t.settings.serverServiceDesc}</p>
    <div className="mt-5 flex gap-3">
      <Button variant="primary" onClick={async () => { await close(); navigate('/settings/account'); }}>{t.settings.serverLogin}</Button>
      <Button variant="ghost" onClick={() => void close()}>{t.common.close}</Button>
    </div>
  </Dialog>;
}
