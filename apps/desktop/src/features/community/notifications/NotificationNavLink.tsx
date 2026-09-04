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
      className={({ isActive }) =>
        cn(
          'mb-0.5 flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm transition',
          isActive
            ? 'bg-paper-0 font-medium text-ink-900 shadow-soft dark:bg-paper-800 dark:text-paper-50'
            : 'text-ink-600 hover:bg-paper-200/60 dark:text-ink-300 dark:hover:bg-paper-800/60',
          className,
        )
      }
    >
      {({ isActive }) => (
        <>
          <Bell size={16} strokeWidth={1.75} aria-hidden="true" className={isActive ? 'text-tea-600' : 'text-ink-400'} />
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
