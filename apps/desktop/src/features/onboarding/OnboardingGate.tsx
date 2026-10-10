import { useEffect, useState } from 'react';
import { getSetting, setSetting } from '@/db/repos/settingsRepo';
import { useSettings } from '@/stores/settingsStore';
import { ONBOARDING_DONE_KEY } from './steps';
import { OnboardingWizard } from './OnboardingWizard';
import { ServerOnboarding } from './ServerOnboarding';

/**
 * 决定要不要弹首启引导：已经配过供应商、或者已经走过（含主动跳过）一次的都不再打扰。
 * 挂在 AppShell 里，这样向导内部可以直接用路由导航。
 */
export function OnboardingGate() {
  const [show, setShow] = useState(false);
  const mode = useSettings(s => s.settings.aiServiceMode);
  useEffect(() => {
    void (async () => {
      const done = await getSetting<boolean>(ONBOARDING_DONE_KEY, false).catch(() => true);
      if (done) return;
      // 老用户（环境变量种过、或手动加过）直接标记完成，不弹。
      if (useSettings.getState().providers.length > 0) {
        await setSetting(ONBOARDING_DONE_KEY, true).catch(() => undefined);
        return;
      }
      setShow(true);
    })();
  }, []);
  if (!show) return null;
  if (mode !== 'local') return <ServerOnboarding onClose={() => setShow(false)} />;
  return <OnboardingWizard onClose={() => setShow(false)} />;
}
