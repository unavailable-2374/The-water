import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, Ban, Eye, GitFork, Heart, Share2, ShieldOff } from 'lucide-react';
import { BADGE_BY_ID, type BadgeId, type NovelSummary, type UserProfile } from '@the-water/shared';
import { fmt, t } from '@/i18n';
import { Avatar } from '@/components/Avatar';
import { Badge, Button, cn, confirm, EmptyState, Spinner } from '@/components/ui';
import { useAsyncData, usePagedList } from '@/components/data/useAsyncData';
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

// 写成函数而不是模块顶层常量表：`t` 是惰性代理，常量表会把文案固定在旧语言上。
function tabs(): Array<{ key: Tab; label: string }> {
  return [
    { key: 'original', label: t.community.original },
    { key: 'derivative', label: t.community.derivative },
    { key: 'activity', label: t.community.activity },
  ];
}

/** 作者主页头部要的三样东西：客户端、服务器地址、作者本人。 */
interface AuthorView {
  client: PublicApi;
  serverUrl: string;
  user: UserProfile;
}

export function AuthorPage() {
  const { handle = '' } = useParams();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab | null) ?? 'original';
  const { account, loaded, refresh } = useAccount();
  const [shareOpen, setShareOpen] = useState(false);
  const { requireLogin, loginDialog } = useLoginGate(t.publicArea.loginGateFollow);
  const learn = useCommunity((s) => s.learn);

  useEffect(() => { if (!loaded) void refresh(); }, [loaded, refresh]);

  const { data, error, reload, setData } = useAsyncData<AuthorView>(
    async () => {
      const client = await getBrowseClient();
      const serverUrl = await getServerUrl();
      // 老服务器可能没有 @用户名，退回按 id 查。
      const { user } = await client.getUserByHandle(handle).catch(() => client.getUser(handle));
      if (user.viewer) learn(user.id, { following: user.viewer.following, blocked: user.viewer.blocked });
      return { client, serverUrl, user };
    },
    { key: JSON.stringify({ handle, viewer: account?.userId, server: account?.serverUrl }) },
  );

  const user = data?.user ?? null;
  const followerCount = user?.followerCount ?? 0;
  const blocked = useBlockState(user?.id ?? '', user?.viewer?.blocked ?? false);

  /** 关注数由 FollowButton 回传，就地改一下，不用为此重取整个主页。 */
  const setFollowerCount = (n: number) =>
    setData((prev) => (prev ? { ...prev, user: { ...prev.user, followerCount: n } } : prev!));

  const toggleBlock = async () => {
    if (!user || !requireLogin()) return;
    if (!blocked && !(await confirm({ title: t.community.blockConfirm, confirmText: t.common.confirm, tone: 'danger' }))) return;
    try {
      const c = await getClient();
      if (!c) return;
      const res = blocked ? await c.unblock(user.id) : await c.block(user.id);
      learn(user.id, { blocked: res.blocked, ...(res.blocked ? { following: false } : {}) });
      toast.success(res.blocked ? t.community.blockedToast : t.community.unblockedToast);
      reload();
    } catch (e) {
      toast.error(friendlyError(e));
    }
  };

  if (error !== null) {
    return (
      <div className="p-8">
        <Button size="sm" variant="ghost" onClick={() => nav('/public')}><ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />{t.common.back}</Button>
        <div role="alert" className="mt-6 rounded-2xl bg-cinnabar-50 px-4 py-3 text-sm text-cinnabar-700 dark:bg-cinnabar-700/20 dark:text-cinnabar-100">{friendlyError(error)}</div>
      </div>
    );
  }
  if (!data || !user) return <div role="status" className="flex h-full items-center justify-center text-sm text-ink-400"><Spinner className="mr-2" />{t.common.loading}</div>;

  const { client, serverUrl } = data;
  const isMe = account?.userId === user.id;
  const share = authorShareTarget(user, serverUrl || client.baseUrl);

  return (
    <div className="h-full overflow-y-auto bg-paper-50 dark:bg-paper-950">
      <div className="mx-auto max-w-4xl px-10 py-8">
        <Button size="sm" variant="ghost" className="mb-4 px-2" onClick={() => nav('/public')}><ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />{t.nav.public}</Button>

        <header className="flex flex-wrap items-start gap-6">
          <Avatar seed={user.handle || user.id} name={user.displayName} size="xl" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-sans text-2xl font-semibold tracking-tight">{user.displayName}</h1>
              <LevelBadge level={user.level} />
              {user.viewer?.blockedBy && <Badge tone="neutral">{t.community.blockedByNotice}</Badge>}
            </div>
            <div className="mt-1 text-sm text-ink-400">@{user.handle}</div>
            <p className={cn('mt-3 max-w-xl whitespace-pre-wrap text-sm leading-relaxed text-ink-600 dark:text-ink-300', !user.bio && 'text-ink-400')}>
              {user.bio || t.community.noBio}
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 font-serif text-xs text-ink-500">
              <span>{t.community.followers} {followerCount}</span>
              <span>{t.community.followingCount} {user.stats.followingCount}</span>
              <span className="inline-flex items-center gap-1"><Heart size={12} strokeWidth={1.75} aria-hidden="true" />{user.stats.likeReceived}</span>
              <span className="inline-flex items-center gap-1"><Eye size={12} strokeWidth={1.75} aria-hidden="true" />{user.stats.viewReceived}</span>
              <span className="inline-flex items-center gap-1"><GitFork size={12} strokeWidth={1.75} aria-hidden="true" />{fmt(t.community.derivedCount, { n: user.stats.derivedCount })}</span>
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
              <Button size="md" variant="ghost" onClick={() => setShareOpen(true)}><Share2 size={16} strokeWidth={1.75} aria-hidden="true" />{t.community.share}</Button>
              {!isMe && (
                <Button size="md" variant="ghost" className={cn(!blocked && 'hover:text-cinnabar-600')} onClick={toggleBlock}>
                  {blocked ? <ShieldOff size={16} strokeWidth={1.75} aria-hidden="true" /> : <Ban size={16} strokeWidth={1.75} aria-hidden="true" />}
                  {blocked ? t.community.unblock : t.community.block}
                </Button>
              )}
            </div>
            {blocked && <p className="mt-3 text-xs text-ink-400">{t.community.blockedNotice}</p>}
          </div>
        </header>

        <div className="mt-9">
          <div role="tablist" aria-label={t.community.authorTabsLabel} className="mb-4 inline-flex gap-1 rounded-full bg-paper-200/70 p-1 dark:bg-paper-900/70">
            {tabs().map((x) => (
              <button
                key={x.key}
                role="tab"
                aria-selected={tab === x.key}
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
  const { items, initializing, loadingMore, error, hasMore, reload, loadMore } = usePagedList<NovelSummary>(
    async ({ cursor }) => {
      const page = await client.listUserNovels(userId, { kind, cursor: cursor ?? undefined, limit: 20 });
      return { items: page.items, nextCursor: page.nextCursor };
    },
    { key: JSON.stringify({ userId, kind, server: client.baseUrl }) },
  );

  if (error !== null) {
    return (
      <div role="alert" className="flex items-center justify-between gap-3 rounded-2xl bg-cinnabar-50 px-4 py-3 text-sm text-cinnabar-700 dark:bg-cinnabar-700/20 dark:text-cinnabar-100">
        <span>{friendlyError(error)}</span>
        <Button size="sm" onClick={reload}>{t.common.retry}</Button>
      </div>
    );
  }
  if (initializing) return <div role="status" className="py-10 text-center text-sm text-ink-400"><Spinner className="mr-2" />{t.common.loading}</div>;
  if (items.length === 0) {
    return <EmptyState title={kind === 'original' ? t.community.noOriginals : t.community.noDerivatives} />;
  }
  return (
    <>
      <ul aria-label={t.publicArea.novelListLabel} className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-8 gap-y-10">
        {items.map((n) => <NovelCard key={n.id} novel={n} onOpen={() => nav(`/public/${n.id}`)} />)}
      </ul>
      {hasMore && (
        <div className="mt-8 flex justify-center" aria-live="polite">
          <Button size="sm" variant="ghost" onClick={loadMore} disabled={loadingMore}>{t.common.more}</Button>
        </div>
      )}
    </>
  );
}
