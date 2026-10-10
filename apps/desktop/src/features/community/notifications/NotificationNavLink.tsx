import { NavLink } from 'react-router';
import { Bell } from 'lucide-react';
import { cn } from '@/components/ui';
import { fmt, t } from '@/i18n';
import { useAccount } from '@/stores/accountStore';
import { useUnreadNotifications } from '@/stores/communityStore';
import { unreadBadgeText } from './kinds';

/**
 * 侧栏的「通知」入口，自带小红点（§3.1）。
 * 样式与 AppShell 里其它导航项一致，AppShell 只需要放一行 `<NotificationNavLink />`。
 * 未登录时不渲染：没有账号就不会有通知。
 */
export function NotificationNavLink({ className }: { className?: string }) {
  const account = useAccount((s) => s.account);
  const unread = useUnreadNotifications();
  if (!account) return null;
  const badge = unreadBadgeText(unread);

  return (
    <NavLink
      to="/public/notifications"
      className={cn('nav-item', className)}
    >
      {() => (
        <>
          <Bell size={18} strokeWidth={1.75} aria-hidden="true" />
          {t.community.notifications}
          {badge && (
            <span aria-label={fmt(t.community.unreadCountLabel, { n: badge })} className="ml-auto min-w-[18px] rounded-full bg-cinnabar-500 px-1.5 text-center font-serif text-[10px] leading-[18px] text-paper-0">
              {badge}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}
