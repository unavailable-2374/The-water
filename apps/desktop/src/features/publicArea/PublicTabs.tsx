import { NavLink } from 'react-router';
import { cn } from '@/components/ui';
import { t } from '@/i18n';

// 绝对路径：这些页面可能渲染在 splat 路由下，相对 to 会嵌套。
// 写成函数而不是模块顶层常量表：`t` 是惰性代理，切语言时常量表会停在旧文案。
function tabs(): Array<{ to: string; label: string; end: boolean }> {
  return [
    { to: '/public', label: t.community.tabs.browse, end: true },
    { to: '/public/feed', label: t.community.tabs.feed, end: false },
    { to: '/public/ranking', label: t.community.tabs.ranking, end: false },
    { to: '/public/mine', label: t.publicArea.tabMine, end: false },
  ];
}

/** 公共书房的几张脸：书房 / 动态 / 榜单 / 我的发布。 */
export function PublicTabs() {
  return (
    <nav aria-label={t.publicArea.tabsLabel} className="inline-flex gap-1 rounded-full bg-paper-200/70 p-1 dark:bg-paper-900/70">
      {tabs().map((tab) => (
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
