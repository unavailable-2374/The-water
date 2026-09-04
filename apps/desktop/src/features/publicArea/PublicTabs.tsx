import { NavLink } from 'react-router';
import { cn } from '@/components/ui';
import { t } from '@/i18n/zh';

// 绝对路径：这些页面可能渲染在 splat 路由下，相对 to 会嵌套。
const TABS = [
  { to: '/public', label: t.community.tabs.browse, end: true },
  { to: '/public/feed', label: t.community.tabs.feed, end: false },
  { to: '/public/ranking', label: t.community.tabs.ranking, end: false },
];

/** 公共书房的三张脸：书房 / 动态 / 榜单。 */
export function PublicTabs() {
  return (
    <nav className="inline-flex gap-1 rounded-full bg-paper-200/70 p-1 dark:bg-paper-900/70">
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) =>
            cn(
              'rounded-full px-4 py-1.5 text-sm transition',
              isActive ? 'bg-paper-0 font-medium text-ink-900 shadow-soft dark:bg-paper-800 dark:text-paper-50' : 'text-ink-500 hover:text-ink-800 dark:hover:text-paper-100',
            )
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
