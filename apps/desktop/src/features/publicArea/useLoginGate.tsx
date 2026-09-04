import { useCallback, useState, type ReactNode } from 'react';
import { Dialog } from '@/components/ui';
import { t } from '@/i18n';
import { useAccount } from '@/stores/accountStore';
import { LoginForm } from '@/features/settings/AccountPanel';

/**
 * 需要登录才能做的事（喜欢、关注、留言、二创）统一走这里：
 * requireLogin() 返回 false 时会弹出登录框，把 loginDialog 渲染进页面即可。
 */
export function useLoginGate(subtitle?: string): {
  requireLogin: () => boolean;
  openLogin: () => void;
  loginDialog: ReactNode;
} {
  const account = useAccount((s) => s.account);
  const [open, setOpen] = useState(false);

  const openLogin = useCallback(() => setOpen(true), []);
  const requireLogin = useCallback(() => {
    if (account) return true;
    setOpen(true);
    return false;
  }, [account]);

  const loginDialog = (
    <Dialog open={open} onClose={() => setOpen(false)} title={t.publicArea.login} subtitle={subtitle ?? t.publicArea.loginGateDefault} width="max-w-sm">
      <LoginForm onDone={() => setOpen(false)} />
    </Dialog>
  );
  return { requireLogin, openLogin, loginDialog };
}
