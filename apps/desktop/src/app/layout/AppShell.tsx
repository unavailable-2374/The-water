import { Link, Outlet, useLocation } from 'react-router';
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
    <div className="flex h-full bg-paper-50 dark:bg-paper-950">
      {!immersive && (
        <nav aria-label={t.nav.sidebar} className="app-sidebar m-3 mr-0 flex w-[224px] shrink-0 flex-col rounded-[22px] px-3 py-5 shadow-soft">
          <div className="mb-9 flex items-center gap-3 px-2 pt-1">
            <img src="/logo.svg" alt="" aria-hidden="true" width={40} height={40} className="h-10 w-10 shrink-0 shadow-soft" />
            <div>
              <div className="text-[15px] font-semibold tracking-tight">{t.app.name}</div>
              <div className="mt-0.5 text-[11px] text-ink-500">{t.app.tagline}</div>
            </div>
          </div>
          {groups.map((g, gi) => {
            const title = g.title();
            return (
              <div key={g.id} className={cn('mb-6', gi === groups.length - 1 && 'mt-auto mb-0 border-t border-paper-300/50 pt-3 dark:border-paper-800')}>
                {title && <div className="mb-2 px-3 text-[11px] font-medium text-ink-500">{title}</div>}
                {g.items.map(({ key, to, label, icon: Icon }) => {
                  const on = active === key;
                  return (
                    <Link
                      key={key}
                      to={to}
                      // Query-aware selection is owned by activeNavKey, not pathname matching.
                      aria-current={on ? 'page' : undefined}
                      className="nav-item"
                    >
                      <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
                      {label()}
                    </Link>
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
