import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { ShieldOff, UserMinus } from 'lucide-react';
import type { UserCard } from '@the-water/shared';
import { t } from '@/i18n/zh';
import { Avatar } from '@/components/Avatar';
import { Button, Card, EmptyState, Spinner, cn } from '@/components/ui';
import { toast } from '@/components/Toast';
import { authorPath } from '@/components/UserChip';
import { friendlyError } from '@/community/errors';
import { getClient } from '@/sync/account';
import { useAccount } from '@/stores/accountStore';
import { useCommunity } from '@/stores/communityStore';
import { LevelBadge } from '@/features/community/LevelBadge';

type Tab = 'following' | 'followers' | 'blocks';
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'following', label: t.community.followingCount },
  { key: 'followers', label: t.community.followers },
  { key: 'blocks', label: t.community.blocked },
];

/** 设置 → 关注与屏蔽：三份名单，可直接取消关注或解除屏蔽。 */
export function RelationsPanel() {
  const { account, loaded, refresh } = useAccount();
  const [tab, setTab] = useState<Tab>('following');
  const [items, setItems] = useState<UserCard[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const learn = useCommunity((s) => s.learn);
  const nav = useNavigate();

  useEffect(() => { if (!loaded) void refresh(); }, [loaded, refresh]);

  const load = useCallback(
    async (append: boolean, from: string | null) => {
      setBusy(true);
      try {
        const client = await getClient();
        if (!client) {
          setItems([]);
          return;
        }
        const query = { cursor: append && from ? from : undefined, limit: 50 };
        const page =
          tab === 'following' ? await client.myFollowing(query) : tab === 'followers' ? await client.myFollowers(query) : await client.myBlocks(query);
        setItems((prev) => (append && prev ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch (e) {
        toast.error(friendlyError(e));
        setItems((prev) => prev ?? []);
      } finally {
        setBusy(false);
      }
    },
    [tab],
  );
  useEffect(() => { setItems(null); void load(false, null); }, [load, account?.userId]);

  const act = async (u: UserCard) => {
    try {
      const client = await getClient();
      if (!client) return;
      if (tab === 'blocks') {
        await client.unblock(u.id);
        learn(u.id, { blocked: false });
        toast.success('已解除屏蔽');
      } else {
        await client.unfollow(u.id);
        learn(u.id, { following: false });
        toast.success('已取消关注');
      }
      setItems((prev) => (prev ? prev.filter((x) => x.id !== u.id) : prev));
    } catch (e) {
      toast.error(friendlyError(e));
    }
  };

  if (!loaded) return <div className="text-sm text-ink-400">{t.common.loading}</div>;
  if (!account) {
    return (
      <div className="max-w-md space-y-4">
        <h1 className="font-serif text-2xl font-semibold tracking-wide">{t.community.relations}</h1>
        <EmptyState title="登录后才能管理关注与屏蔽" action={<Button variant="primary" onClick={() => nav('/settings/account')}>去登录</Button>} />
      </div>
    );
  }

  const empty = tab === 'following' ? t.community.followingEmpty : tab === 'followers' ? t.community.followersEmpty : t.community.blocksEmpty;

  return (
    <div className="max-w-2xl space-y-6">
      <header>
        <h1 className="font-serif text-2xl font-semibold tracking-wide">{t.community.relations}</h1>
        <p className="mt-1 text-sm leading-relaxed text-ink-500">关注的人会出现在「动态」里；屏蔽后你们彼此看不到对方的故事和留言。</p>
      </header>

      <div className="inline-flex gap-1 rounded-full bg-paper-200/70 p-1 text-sm dark:bg-paper-900/70">
        {TABS.map((x) => (
          <button
            key={x.key}
            onClick={() => setTab(x.key)}
            className={cn('rounded-full px-4 py-1.5 transition', tab === x.key ? 'bg-paper-0 font-medium text-ink-900 shadow-soft dark:bg-paper-800 dark:text-paper-50' : 'text-ink-500 hover:text-ink-800 dark:hover:text-paper-100')}
          >
            {x.label}
          </button>
        ))}
      </div>

      {items === null ? (
        <div className="text-sm text-ink-400"><Spinner className="mr-2" />{t.common.loading}</div>
      ) : items.length === 0 ? (
        <EmptyState title={empty} />
      ) : (
        <ul className="space-y-2">
          {items.map((u) => (
            <li key={u.id}>
              <Card className="flex items-center gap-4 p-3">
                <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => nav(authorPath(u))}>
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
                    {tab === 'blocks' ? <ShieldOff size={16} strokeWidth={1.75} /> : <UserMinus size={16} strokeWidth={1.75} />}
                    {tab === 'blocks' ? t.community.unblock : t.community.unfollow}
                  </Button>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <div className="flex justify-center">
          <Button size="sm" variant="ghost" onClick={() => load(true, cursor)} disabled={busy}>加载更多</Button>
        </div>
      )}
    </div>
  );
}
