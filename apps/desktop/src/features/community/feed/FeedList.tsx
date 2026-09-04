import type { FeedItem, FeedQuery } from '@the-water/shared';
import { t } from '@/i18n';
import { Button, EmptyState, Spinner } from '@/components/ui';
import { usePagedList } from '@/components/data/useAsyncData';
import { friendlyError } from '@/community/errors';
import { getBrowseClient } from '@/sync/account';
import { useAccount } from '@/stores/accountStore';
import { ActivityCard } from './ActivityCard';

interface Props {
  query: Partial<FeedQuery>;
  emptyTitle: string;
  emptyDescription?: string;
  emptyAction?: React.ReactNode;
}

/** 动态列表：作者主页与「动态」页共用。 */
export function FeedList({ query, emptyTitle, emptyDescription, emptyAction }: Props) {
  const account = useAccount((s) => s.account);
  const { items, initializing, loadingMore, error, hasMore, reload, loadMore } = usePagedList<FeedItem>(
    async ({ cursor }) => {
      const client = await getBrowseClient();
      const page = await client.feed({ ...query, cursor: cursor ?? undefined, limit: 20 });
      return { items: page.items, nextCursor: page.nextCursor };
    },
    // 「关注的作者」这类范围随登录态变，所以账号和服务器都要拼进 key。
    { key: JSON.stringify({ ...query, user: account?.userId, server: account?.serverUrl }) },
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
  if (items.length === 0) return <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />;

  return (
    <>
      <ul aria-label={t.community.feedListLabel} className="space-y-3">
        {items.map((item) => <ActivityCard key={item.id} item={item} />)}
      </ul>
      <div className="mt-8 flex justify-center" aria-live="polite">
        {loadingMore ? <Spinner /> : hasMore ? <Button size="sm" variant="ghost" onClick={loadMore}>{t.common.more}</Button> : <span className="font-serif text-xs text-ink-400">{t.common.reachedEnd}</span>}
      </div>
    </>
  );
}
