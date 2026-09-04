import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Award, Bell, GitBranch, Heart, MessageSquare, ShieldAlert, UserPlus } from 'lucide-react';
import type { Notification } from '@the-water/shared';
import { fmt, t } from '@/i18n';
import { Button, EmptyState, Spinner, cn } from '@/components/ui';
import { usePagedList } from '@/components/data/useAsyncData';
import { Avatar } from '@/components/Avatar';
import { toast } from '@/components/Toast';
import { friendlyError } from '@/community/errors';
import { getClient } from '@/sync/account';
import { useAccount } from '@/stores/accountStore';
import { useCommunity } from '@/stores/communityStore';
import { groupNotifications, notificationIcon, notificationTarget, notificationTone, type NotificationIconName } from './kinds';

const ICON_COMPONENTS: Record<NotificationIconName, typeof Bell> = {
  follow: UserPlus,
  like: Heart,
  comment: MessageSquare,
  fork: GitBranch,
  badge: Award,
  shield: ShieldAlert,
};

const TONE_CLASS = {
  tea: 'bg-tea-50 text-tea-700 dark:bg-tea-700/20 dark:text-tea-200',
  cinnabar: 'bg-cinnabar-50 text-cinnabar-700 dark:bg-cinnabar-700/20 dark:text-cinnabar-100',
  ink: 'bg-paper-200/70 text-ink-500 dark:bg-paper-800 dark:text-ink-300',
} as const;

function when(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return t.community.justNow;
  if (diff < 3_600_000) return fmt(t.community.minutesAgo, { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return fmt(t.community.hoursAgo, { n: Math.floor(diff / 3_600_000) });
  return d.toLocaleDateString();
}

type Filter = 'all' | 'unread';

/** 站内通知列表（§3.1）。点开一条即标为已读并跳到对应的作品 / 主页。 */
export function NotificationsPage() {
  const nav = useNavigate();
  const account = useAccount((s) => s.account);
  const setUnread = useCommunity((s) => s.setUnread);
  const [filter, setFilter] = useState<Filter>('all');
  const [unreadCount, setUnreadCount] = useState(0);

  const { items, initializing, loadingMore, error, hasMore, reload, loadMore, setItems } = usePagedList<Notification>(
    async ({ cursor }) => {
      const client = await getClient();
      if (!client) return { items: [], nextCursor: null };
      const page = await client.listNotifications({ filter, cursor: cursor ?? undefined, limit: 30 });
      // 未读数是这份响应顺带给的，抄进侧栏小红点。
      setUnreadCount(page.unreadCount);
      setUnread(page.unreadCount);
      return { items: page.items, nextCursor: page.nextCursor };
    },
    { key: JSON.stringify({ filter, user: account?.userId, server: account?.serverUrl }), enabled: !!account },
  );

  const markRead = async (ids: string[] | 'all') => {
    try {
      const client = await getClient();
      if (!client) return;
      const res = await client.markNotificationsRead(ids === 'all' ? { all: true } : { ids });
      setUnreadCount(res.unreadCount);
      setUnread(res.unreadCount);
      const now = new Date().toISOString();
      setItems((prev) =>
        prev.flatMap((n) => {
          const hit = ids === 'all' || ids.includes(n.id);
          if (!hit) return [n];
          // 「只看未读」时读过的就该从列表里退场。
          if (filter === 'unread') return [];
          return [{ ...n, readAt: n.readAt ?? now }];
        }),
      );
    } catch (e) {
      toast.error(friendlyError(e));
    }
  };

  const open = (n: Notification) => {
    if (!n.readAt) void markRead([n.id]);
    const to = notificationTarget(n);
    if (to) nav(to);
  };

  const groups = groupNotifications(items);

  return (
    <div className="h-full overflow-y-auto bg-paper-50 dark:bg-paper-950">
      <div className="mx-auto max-w-3xl px-10 py-10">
        <header className="mb-6 flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-3xl font-semibold tracking-wide">{t.community.notifications}</h1>
            <p className="mt-1 text-sm text-ink-500">{t.community.notificationsSubtitle}</p>
          </div>
          {unreadCount > 0 && (
            <Button size="sm" variant="ghost" onClick={() => void markRead('all')}>
              {t.community.markAllRead}
            </Button>
          )}
        </header>

        {account && (
          <div role="tablist" aria-label={t.community.filterLabel} className="mb-6 inline-flex gap-1 rounded-full bg-paper-200/70 p-1 text-sm dark:bg-paper-900/70">
            {(['all', 'unread'] as const).map((f) => (
              <button
                key={f}
                role="tab"
                aria-selected={filter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  'rounded-full px-4 py-1.5 transition',
                  filter === f
                    ? 'bg-paper-0 font-medium text-ink-900 shadow-soft dark:bg-paper-800 dark:text-paper-50'
                    : 'text-ink-500 hover:text-ink-800 dark:hover:text-paper-100',
                )}
              >
                {f === 'all' ? t.community.filterAll : `${t.community.filterUnread}${unreadCount > 0 ? ` ${unreadCount}` : ''}`}
              </button>
            ))}
          </div>
        )}

        <div aria-live="polite">
          {!account ? (
            <EmptyState title={t.community.notifyNeedLogin} description={t.community.notifyNeedLoginDesc} />
          ) : error !== null ? (
            <div role="alert" className="flex items-center justify-between gap-3 rounded-2xl bg-cinnabar-50 px-4 py-3 text-sm text-cinnabar-700 dark:bg-cinnabar-700/20 dark:text-cinnabar-100">
              <span>{friendlyError(error)}</span>
              <Button size="sm" onClick={reload}>{t.common.retry}</Button>
            </div>
          ) : initializing ? (
            <div role="status" className="py-10 text-center text-sm text-ink-400">
              <Spinner className="mr-2" />
              {t.common.loading}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<Bell size={22} strokeWidth={1.5} aria-hidden="true" />}
              title={filter === 'unread' ? t.community.noUnread : t.community.noNotifications}
              description={t.community.notifyEmptyDesc}
              action={<Button variant="primary" onClick={() => nav('/public')}>{t.community.goPublic}</Button>}
            />
          ) : (
            groups.map((g) => (
              <section key={g.label} className="mb-6">
                <div className="mb-2 px-1 text-[11px] font-medium tracking-widest text-ink-400">{g.label}</div>
                <ul aria-label={t.community.notificationListLabel} className="space-y-2">
                  {g.items.map((n) => {
                    const Icon = ICON_COMPONENTS[notificationIcon(n.kind)];
                    const clickable = notificationTarget(n) !== null;
                    return (
                      <li key={n.id}>
                        <div
                          role={clickable ? 'button' : undefined}
                          tabIndex={clickable ? 0 : undefined}
                          aria-label={clickable ? n.title : undefined}
                          onClick={() => open(n)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              open(n);
                            }
                          }}
                          className={cn(
                            'flex items-start gap-3 rounded-2xl bg-paper-0 p-4 shadow-soft transition dark:bg-paper-900',
                            clickable && 'cursor-pointer hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-tea-500/50',
                            !n.readAt && 'ring-1 ring-tea-500/30',
                          )}
                        >
                          <span aria-hidden="true" className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl', TONE_CLASS[notificationTone(n.kind)])}>
                            <Icon size={15} strokeWidth={1.75} />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-3">
                              <p className="text-sm leading-relaxed text-ink-800 dark:text-paper-100">{n.title}</p>
                              <span className="shrink-0 text-[11px] text-ink-400">{when(n.createdAt)}</span>
                            </div>
                            {n.body && <p className="mt-1 truncate text-xs text-ink-500 dark:text-ink-300">{n.body}</p>}
                          </div>
                          {n.actor && <Avatar seed={n.actor.handle || n.actor.id} name={n.actor.displayName} size="xs" />}
                          {!n.readAt && <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-cinnabar-500" role="img" aria-label={t.community.unread} />}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>

        {hasMore && (
          <div className="mt-2 flex justify-center">
            <Button size="sm" variant="ghost" onClick={loadMore} disabled={loadingMore}>
              {t.common.more}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
