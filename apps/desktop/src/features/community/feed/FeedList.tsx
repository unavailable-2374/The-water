import { useCallback, useEffect, useState } from 'react';
import type { FeedItem, FeedQuery } from '@the-water/shared';
import { t } from '@/i18n/zh';
import { Button, EmptyState, Spinner } from '@/components/ui';
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
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = JSON.stringify(query);

  const load = useCallback(
    async (append: boolean, from: string | null) => {
      setBusy(true);
      setError(null);
      try {
        const client = await getBrowseClient();
        const page = await client.feed({ ...(JSON.parse(key) as Partial<FeedQuery>), cursor: append && from ? from : undefined, limit: 20 });
        setItems((prev) => (append && prev ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch (e) {
        setError(friendlyError(e));
        if (!append) setItems([]);
      } finally {
        setBusy(false);
      }
    },
    [key],
  );

  useEffect(() => { setItems(null); void load(false, null); }, [load, account?.userId, account?.serverUrl]);

  if (error) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-2xl bg-cinnabar-50 px-4 py-3 text-sm text-cinnabar-700 dark:bg-cinnabar-700/20 dark:text-cinnabar-100">
        <span>{error}</span>
        <Button size="sm" onClick={() => load(false, null)}>{t.common.retry}</Button>
      </div>
    );
  }
  if (items === null) return <div className="py-10 text-center text-sm text-ink-400"><Spinner className="mr-2" />{t.common.loading}</div>;
  if (items.length === 0) return <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />;

  return (
    <>
      <ul className="space-y-3">
        {items.map((item) => <ActivityCard key={item.id} item={item} />)}
      </ul>
      <div className="mt-8 flex justify-center">
        {busy ? <Spinner /> : cursor ? <Button size="sm" variant="ghost" onClick={() => load(true, cursor)}>再看一些</Button> : <span className="font-serif text-xs text-ink-400">— 已经翻到底了 —</span>}
      </div>
    </>
  );
}
