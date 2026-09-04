import { NavLink, Outlet, useLocation } from 'react-router';
import { BookOpen, Feather, Compass, MessageSquare, Settings, type LucideIcon } from 'lucide-react';
import { t } from '@/i18n';
import { cn } from '@/components/ui';
import { JobProgressBar } from '@/features/studio/JobProgressBar';
import { OnboardingGate } from '@/features/onboarding/OnboardingGate';
import { NotificationNavLink } from '@/features/community/notifications/NotificationNavLink';
import { activeNavKey, isImmersiveRoute, type NavKey } from './navigation';

interface NavItem { key: NavKey; to: string; label: () => string; icon: LucideIcon }
/** `id` 是稳定的分组标识；标题是会随语言变的文案，不能拿来做判断。 */
interface NavGroup { id: 'read' | 'write' | 'discover' | 'utility'; title: () => string; items: NavItem[] }

const groups: NavGroup[] = [
  { id: 'read', title: () => t.nav.groupRead, items: [{ key: 'library', to: '/library', label: () => t.nav.library, icon: BookOpen }] },
  { id: 'write', title: () => t.nav.groupWrite, items: [{ key: 'studio', to: '/library?tab=novels', label: () => t.nav.studio, icon: Feather }] },
  { id: 'discover', title: () => t.nav.groupDiscover, items: [{ key: 'public', to: '/public', label: () => t.nav.public, icon: Compass }] },
  {
    id: 'utility',
    title: () => '',
    items: [
      { key: 'chat', to: '/chat', label: () => t.nav.chat, icon: MessageSquare },
      { key: 'settings', to: '/settings', label: () => t.nav.settings, icon: Settings },
    ],
  },
];

export function AppShell() {
  const loc = useLocation();
  const immersive = isImmersiveRoute(loc.pathname);
  const active = activeNavKey(loc.pathname, loc.search);
  return (
    <div className="flex h-full">
      {!immersive && (
        <nav aria-label={t.nav.sidebar} className="flex w-52 flex-col border-r border-paper-300/60 bg-paper-100/80 px-3 py-5 dark:border-paper-800 dark:bg-paper-900/80">
          <div className="mb-6 flex items-center gap-2 px-2">
            <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-xl bg-tea-600 font-serif text-lg font-semibold text-paper-0 shadow-soft">{t.app.mark}</span>
            <div>
              <div className="font-serif text-sm font-semibold tracking-wide">{t.app.name}</div>
              <div className="text-[10px] text-ink-400">{t.app.tagline}</div>
            </div>
          </div>
          {groups.map((g, gi) => {
            const title = g.title();
            return (
              <div key={g.id} className={cn('mb-4', gi === groups.length - 1 && 'mt-auto mb-0')}>
                {title && <div className="mb-1 px-2 text-[10px] font-medium tracking-widest text-ink-400">{title}</div>}
                {g.items.map(({ key, to, label, icon: Icon }) => {
                  const on = active === key;
                  return (
                    <NavLink
                      key={key}
                      to={to}
                      // 高亮由 activeNavKey 统一判定，所以关掉 NavLink 自带的 isActive。
                      aria-current={on ? 'page' : undefined}
                      className={cn(
                        'mb-0.5 flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-tea-500/50',
                        on ? 'bg-paper-0 font-medium text-ink-900 shadow-soft dark:bg-paper-800 dark:text-paper-50' : 'text-ink-600 hover:bg-paper-200/60 dark:text-ink-300 dark:hover:bg-paper-800/60',
                      )}
                    >
                      <Icon size={16} strokeWidth={1.75} aria-hidden="true" className={on ? 'text-tea-600' : 'text-ink-400'} />
                      {label()}
                    </NavLink>
                  );
                })}
                {/* 「发现」组末尾挂通知入口，小红点与未登录隐藏都在组件内部。 */}
                {g.id === 'discover' && <NotificationNavLink />}
              </div>
            );
          })}
        </nav>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
        <JobProgressBar />
      </div>
      <OnboardingGate />
    </div>
  );
}
