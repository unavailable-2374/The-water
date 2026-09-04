import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, Ban, Eye, GitFork, Heart, Share2, ShieldOff } from 'lucide-react';
import { BADGE_BY_ID, type BadgeId, type NovelSummary, type UserProfile } from '@the-water/shared';
import { t } from '@/i18n/zh';
import { Avatar } from '@/components/Avatar';
import { Badge, Button, cn, confirm, EmptyState, Spinner } from '@/components/ui';
import { toast } from '@/components/Toast';
import { friendlyError } from '@/community/errors';
import { getBrowseClient, getClient, getServerUrl } from '@/sync/account';
import type { PublicApi } from '@/sync/api';
import { useAccount } from '@/stores/accountStore';
import { useBlockState, useCommunity } from '@/stores/communityStore';
import { FollowButton } from '@/features/community/FollowButton';
import { LevelBadge } from '@/features/community/LevelBadge';
import { NovelCard } from '@/features/publicArea/BrowsePage';
import { ShareDialog } from '@/features/publicArea/ShareDialog';
import { useLoginGate } from '@/features/publicArea/useLoginGate';
import { authorShareTarget } from '@/community/shareCard';
import { FeedList } from '@/features/community/feed/FeedList';

type Tab = 'original' | 'derivative' | 'activity';
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'original', label: t.community.original },
  { key: 'derivative', label: t.community.derivative },
  { key: 'activity', label: t.community.activity },
];

export function AuthorPage() {
  const { handle = '' } = useParams();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab | null) ?? 'original';
  const { account, loaded, refresh } = useAccount();
  const [client, setClient] = useState<PublicApi | null>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [followerCount, setFollowerCount] = useState(0);
  const [shareOpen, setShareOpen] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const { requireLogin, loginDialog } = useLoginGate('登录后才能关注作者');
  const learn = useCommunity((s) => s.learn);
  const blocked = useBlockState(user?.id ?? '', user?.viewer?.blocked ?? false);

  useEffect(() => { if (!loaded) void refresh(); }, [loaded, refresh]);

  const load = useCallback(async () => {
    setUser(null);
    setError(null);
    try {
      const c = await getBrowseClient();
      setClient(c);
      setServerUrl(await getServerUrl());
      // 老服务器可能没有 @用户名，退回按 id 查。
      const { user: u } = await c.getUserByHandle(handle).catch(() => c.getUser(handle));
      setUser(u);
      setFollowerCount(u.followerCount);
      if (u.viewer) learn(u.id, { following: u.viewer.following, blocked: u.viewer.blocked });
    } catch (e) {
      setError(friendlyError(e));
    }
  }, [handle, learn]);

  useEffect(() => { void load(); }, [load, account?.userId, account?.serverUrl]);

  const toggleBlock = async () => {
    if (!user || !requireLogin()) return;
    if (!blocked && !(await confirm({ title: t.community.blockConfirm, confirmText: t.common.confirm, tone: 'danger' }))) return;
    try {
      const c = await getClient();
      if (!c) return;
      const res = blocked ? await c.unblock(user.id) : await c.block(user.id);
      learn(user.id, { blocked: res.blocked, ...(res.blocked ? { following: false } : {}) });
      toast.success(res.blocked ? '已屏蔽这位作者' : '已解除屏蔽');
      await load();
    } catch (e) {
      toast.error(friendlyError(e));
    }
  };

  if (error) {
    return (
      <div className="p-8">
        <Button size="sm" variant="ghost" onClick={() => nav('/public')}><ArrowLeft size={16} strokeWidth={1.75} />{t.common.back}</Button>
        <div className="mt-6 rounded-2xl bg-cinnabar-50 px-4 py-3 text-sm text-cinnabar-700 dark:bg-cinnabar-700/20 dark:text-cinnabar-100">{error}</div>
      </div>
    );
  }
  if (!user || !client) return <div className="flex h-full items-center justify-center text-sm text-ink-400"><Spinner className="mr-2" />{t.common.loading}</div>;

  const isMe = account?.userId === user.id;
  const share = authorShareTarget(user, serverUrl || client.baseUrl);

  return (
    <div className="h-full overflow-y-auto bg-paper-50 dark:bg-paper-950">
      <div className="mx-auto max-w-4xl px-10 py-8">
        <Button size="sm" variant="ghost" className="mb-4 px-2" onClick={() => nav('/public')}><ArrowLeft size={16} strokeWidth={1.75} />{t.nav.public}</Button>

        <header className="flex flex-wrap items-start gap-6">
          <Avatar seed={user.handle || user.id} name={user.displayName} size="xl" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-serif text-2xl font-semibold tracking-wide">{user.displayName}</h1>
              <LevelBadge level={user.level} />
              {user.viewer?.blockedBy && <Badge tone="neutral">对方屏蔽了你</Badge>}
            </div>
            <div className="mt-1 text-sm text-ink-400">@{user.handle}</div>
            <p className={cn('mt-3 max-w-xl whitespace-pre-wrap text-sm leading-relaxed text-ink-600 dark:text-ink-300', !user.bio && 'text-ink-400')}>
              {user.bio || '这位作者还没有写介绍。'}
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 font-serif text-xs text-ink-500">
              <span>{t.community.followers} {followerCount}</span>
              <span>{t.community.followingCount} {user.stats.followingCount}</span>
              <span className="inline-flex items-center gap-1"><Heart size={12} strokeWidth={1.75} />{user.stats.likeReceived}</span>
              <span className="inline-flex items-center gap-1"><Eye size={12} strokeWidth={1.75} />{user.stats.viewReceived}</span>
              <span className="inline-flex items-center gap-1"><GitFork size={12} strokeWidth={1.75} />被二创 {user.stats.derivedCount}</span>
              <span>{user.points} {t.community.pointsUnit}</span>
            </div>
            {user.badges.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {user.badges.map((b) => <BadgeChip key={b.id} id={b.id} />)}
              </div>
            )}
            <div className="mt-5 flex flex-wrap items-center gap-2">
              {!isMe && (
                <FollowButton
                  userId={user.id}
                  following={user.viewer?.following ?? false}
                  onCount={setFollowerCount}
                  requireLogin={requireLogin}
                  size="md"
                  hidden={blocked || user.viewer?.blockedBy}
                />
              )}
              <Button size="md" variant="ghost" onClick={() => setShareOpen(true)}><Share2 size={16} strokeWidth={1.75} />{t.community.share}</Button>
              {!isMe && (
                <Button size="md" variant="ghost" className={cn(!blocked && 'hover:text-cinnabar-600')} onClick={toggleBlock}>
                  {blocked ? <ShieldOff size={16} strokeWidth={1.75} /> : <Ban size={16} strokeWidth={1.75} />}
                  {blocked ? t.community.unblock : t.community.block}
                </Button>
              )}
            </div>
            {blocked && <p className="mt-3 text-xs text-ink-400">{t.community.blockedNotice}</p>}
          </div>
        </header>

        <div className="mt-9">
          <div className="mb-4 inline-flex gap-1 rounded-full bg-paper-200/70 p-1 dark:bg-paper-900/70">
            {TABS.map((x) => (
              <button
                key={x.key}
                onClick={() => setParams(x.key === 'original' ? {} : { tab: x.key }, { replace: true })}
                className={cn(
                  'rounded-full px-4 py-1.5 text-sm transition',
                  tab === x.key ? 'bg-paper-0 font-medium text-ink-900 shadow-soft dark:bg-paper-800 dark:text-paper-50' : 'text-ink-500 hover:text-ink-800 dark:hover:text-paper-100',
                )}
              >
                {x.label}
              </button>
            ))}
          </div>
          {tab === 'activity' ? (
            <FeedList query={{ scope: 'all', actorId: user.id }} emptyTitle={t.community.noActivity} />
          ) : (
            <NovelGrid client={client} userId={user.id} kind={tab} />
          )}
        </div>
      </div>

      <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} title={t.community.shareAuthor} target={share} cover={null} />
      {loginDialog}
    </div>
  );
}

function BadgeChip({ id }: { id: BadgeId }) {
  const def = BADGE_BY_ID[id];
  return <Badge tone="green">{def ? def.name : id}</Badge>;
}

function NovelGrid({ client, userId, kind }: { client: PublicApi; userId: string; kind: 'original' | 'derivative' }) {
  const nav = useNavigate();
  const [items, setItems] = useState<NovelSummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (append: boolean, from: string | null) => {
      setBusy(true);
      try {
        const page = await client.listUserNovels(userId, { kind, cursor: append && from ? from : undefined, limit: 20 });
        setItems((prev) => (append && prev ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch (e) {
        toast.error(friendlyError(e));
        setItems((prev) => prev ?? []);
      } finally {
        setBusy(false);
      }
    },
    [client, userId, kind],
  );
  useEffect(() => { setItems(null); void load(false, null); }, [load]);

  if (items === null) return <div className="py-10 text-center text-sm text-ink-400"><Spinner className="mr-2" />{t.common.loading}</div>;
  if (items.length === 0) {
    return <EmptyState title={kind === 'original' ? t.community.noOriginals : t.community.noDerivatives} />;
  }
  return (
    <>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-8 gap-y-10">
        {items.map((n) => <NovelCard key={n.id} novel={n} onOpen={() => nav(`/public/${n.id}`)} />)}
      </ul>
      {cursor && (
        <div className="mt-8 flex justify-center">
          <Button size="sm" variant="ghost" onClick={() => load(true, cursor)} disabled={busy}>再看一些</Button>
        </div>
      )}
    </>
  );
}
