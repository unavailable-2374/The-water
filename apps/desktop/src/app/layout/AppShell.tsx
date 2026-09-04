import { NavLink, Outlet, useLocation } from 'react-router';
import { BookOpen, Feather, Compass, MessageSquare, Settings } from 'lucide-react';
import { cn } from '@/components/ui';
import { JobProgressBar } from '@/features/studio/JobProgressBar';

const groups = [
  { title: '阅读', items: [{ to: '/library', match: (p: string, q: string) => p === '/library' && !q.includes('tab=novels'), label: '书架', icon: BookOpen }] },
  { title: '写作', items: [{ to: '/library?tab=novels', match: (p: string, q: string) => (p === '/library' && q.includes('tab=novels')) || p.startsWith('/studio'), label: '我的故事', icon: Feather }] },
  { title: '发现', items: [{ to: '/public', match: (p: string) => p.startsWith('/public'), label: '公共书房', icon: Compass }] },
  { title: '', items: [{ to: '/chat', match: (p: string) => p.startsWith('/chat'), label: '随手问 AI', icon: MessageSquare }, { to: '/settings', match: (p: string) => p.startsWith('/settings'), label: '设置', icon: Settings }] },
];

export function AppShell() {
  const loc = useLocation();
  const immersive = loc.pathname.startsWith('/reader/');
  return (
    <div className="flex h-full">
      {!immersive && (
        <nav className="flex w-52 flex-col border-r border-paper-300/60 bg-paper-100/80 px-3 py-5 dark:border-paper-800 dark:bg-paper-900/80">
          <div className="mb-6 flex items-center gap-2 px-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-tea-600 font-serif text-lg font-semibold text-paper-0 shadow-soft">水</span>
            <div>
              <div className="font-serif text-sm font-semibold tracking-wide">The Water</div>
              <div className="text-[10px] text-ink-400">读一本书，写一个故事</div>
            </div>
          </div>
          {groups.map((g, gi) => (
            <div key={gi} className={cn('mb-4', gi === groups.length - 1 && 'mt-auto mb-0')}>
              {g.title && <div className="mb-1 px-2 text-[10px] font-medium tracking-widest text-ink-400">{g.title}</div>}
              {g.items.map(({ to, label, icon: Icon, match }) => {
                const active = match(loc.pathname, loc.search);
                return (
                  <NavLink key={to} to={to} className={cn('mb-0.5 flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm transition', active ? 'bg-paper-0 font-medium text-ink-900 shadow-soft dark:bg-paper-800 dark:text-paper-50' : 'text-ink-600 hover:bg-paper-200/60 dark:text-ink-300 dark:hover:bg-paper-800/60')}>
                    <Icon size={16} strokeWidth={1.75} className={active ? 'text-tea-600' : 'text-ink-400'} />
                    {label}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
        <JobProgressBar />
      </div>
    </div>
  );
}
