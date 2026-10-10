import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { ShieldOff, UserMinus } from 'lucide-react';
import type { UserCard } from '@the-water/shared';
import { t } from '@/i18n';
import { Avatar } from '@/components/Avatar';
import { Button, Card, EmptyState, Spinner, cn } from '@/components/ui';
import { usePagedList } from '@/components/data/useAsyncData';
import { toast } from '@/components/Toast';
import { authorPath } from '@/components/UserChip';
import { friendlyError } from '@/community/errors';
import { getClient } from '@/sync/account';
import { useAccount } from '@/stores/accountStore';
import { useCommunity } from '@/stores/communityStore';
import { LevelBadge } from '@/features/community/LevelBadge';

type Tab = 'following' | 'followers' | 'blocks';

/**
 * 三个标签。写成函数而不是模块顶层常量表：`t` 是惰性代理，
 * 一旦把文案读进常量里，切语言就更新不了了。
 */
const tabs = (): Array<{ key: Tab; label: string }> => [
  { key: 'following', label: t.community.followingCount },
  { key: 'followers', label: t.community.followers },
  { key: 'blocks', label: t.community.blocked },
];

/** 设置 → 关注与屏蔽：三份名单，可直接取消关注或解除屏蔽。 */
export function RelationsPanel() {
  const { account, loaded, refresh } = useAccount();
  const [tab, setTab] = useState<Tab>('following');
  const learn = useCommunity((s) => s.learn);
  const nav = useNavigate();

  useEffect(() => { if (!loaded) void refresh(); }, [loaded, refresh]);

  // 换标签或换账号，key 一变 usePagedList 就重新从第一页拉。
  const list = usePagedList<UserCard>(
    async ({ cursor }) => {
      const client = await getClient();
      if (!client) return { items: [], nextCursor: null };
      const query = { cursor: cursor ?? undefined, limit: 50 };
      const page = tab === 'following' ? await client.myFollowing(query)
        : tab === 'followers' ? await client.myFollowers(query)
          : await client.myBlocks(query);
      return { items: page.items, nextCursor: page.nextCursor };
    },
    { key: `me:relations:${tab}:${account?.userId ?? ''}`, enabled: loaded && !!account },
  );

  const act = async (u: UserCard) => {
    try {
      const client = await getClient();
      if (!client) return;
      if (tab === 'blocks') {
        await client.unblock(u.id);
        learn(u.id, { blocked: false });
        toast.success(t.settings.unblocked);
      } else {
        await client.unfollow(u.id);
        learn(u.id, { following: false });
        toast.success(t.settings.unfollowed);
      }
      list.setItems((prev) => prev.filter((x) => x.id !== u.id));
    } catch (e) {
      toast.error(friendlyError(e));
    }
  };

  if (!loaded) return <div className="text-sm text-ink-400" role="status">{t.common.loading}</div>;
  if (!account) {
    return (
      <div className="max-w-md space-y-4">
        <h1 className="font-sans text-2xl font-semibold tracking-tight">{t.community.relations}</h1>
        <EmptyState title={t.settings.relationsLoginTitle} action={<Button variant="primary" onClick={() => nav('/settings/account')}>{t.settings.goLogin}</Button>} />
      </div>
    );
  }

  const empty = tab === 'following' ? t.community.followingEmpty : tab === 'followers' ? t.community.followersEmpty : t.community.blocksEmpty;

  return (
    <div className="max-w-2xl space-y-6">
      <header>
        <h1 className="font-sans text-2xl font-semibold tracking-tight">{t.community.relations}</h1>
        <p className="mt-1 text-sm leading-relaxed text-ink-500">{t.settings.relationsDesc}</p>
      </header>

      <div className="inline-flex gap-1 rounded-full bg-paper-200/70 p-1 text-sm dark:bg-paper-900/70" role="tablist" aria-label={t.settings.relationTabs}>
        {tabs().map((x) => (
          <button
            key={x.key}
            type="button"
            role="tab"
            aria-selected={tab === x.key}
            onClick={() => setTab(x.key)}
            className={cn('rounded-full px-4 py-1.5 transition', tab === x.key ? 'bg-paper-0 font-medium text-ink-900 shadow-soft dark:bg-paper-800 dark:text-paper-50' : 'text-ink-500 hover:text-ink-800 dark:hover:text-paper-100')}
          >
            {x.label}
          </button>
        ))}
      </div>

      {list.error ? (
        <Card className="flex items-center justify-between gap-3 text-sm text-ink-500" role="alert">
          <span>{friendlyError(list.error)}</span>
          <Button size="sm" onClick={list.reload}>{t.common.retry}</Button>
        </Card>
      ) : list.initializing ? (
        <div className="text-sm text-ink-400" role="status"><Spinner className="mr-2" />{t.common.loading}</div>
      ) : list.items.length === 0 ? (
        <EmptyState title={empty} />
      ) : (
        <ul className="space-y-2" aria-label={t.settings.relationList}>
          {list.items.map((u) => (
            <li key={u.id}>
              <Card className="flex items-center gap-4 p-3">
                <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => nav(authorPath(u))}>
                  <Avatar seed={u.handle || u.id} name={u.displayName} size="sm" />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{u.displayName}</span>
                      <LevelBadge level={u.level} />
                    </span>
                    <span className="block truncate text-[11px] text-ink-400">@{u.handle}</span>
                  </span>
                </button>
                {tab !== 'followers' && (
                  <Button size="sm" variant="ghost" onClick={() => act(u)}>
                    {tab === 'blocks'
                      ? <ShieldOff size={16} strokeWidth={1.75} aria-hidden="true" />
                      : <UserMinus size={16} strokeWidth={1.75} aria-hidden="true" />}
                    {tab === 'blocks' ? t.community.unblock : t.community.unfollow}
                  </Button>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
      {list.hasMore && (
        <div className="flex justify-center">
          <Button size="sm" variant="ghost" onClick={list.loadMore} disabled={list.loadingMore}>
            {list.loadingMore && <Spinner className="mr-2 h-3 w-3" />}{t.common.loadMore}
          </Button>
        </div>
      )}
    </div>
  );
}
