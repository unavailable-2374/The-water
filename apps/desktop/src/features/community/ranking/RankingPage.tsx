import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { LeaderboardQuery, LeaderboardResponse } from '@the-water/shared';
import { t } from '@/i18n/zh';
import { Avatar } from '@/components/Avatar';
import { BookCover, Button, EmptyState, Spinner, cn } from '@/components/ui';
import { friendlyError } from '@/community/errors';
import { getBrowseClient } from '@/sync/account';
import { authorPath } from '@/components/UserChip';
import { LevelBadge } from '@/features/community/LevelBadge';
import { PublicTabs } from '@/features/publicArea/PublicTabs';

type Board = LeaderboardQuery['board'];
type Period = LeaderboardQuery['period'];

const BOARDS: Array<{ key: Board; label: string }> = [
  { key: 'authors', label: t.community.boardAuthors },
  { key: 'novels', label: t.community.boardNovels },
];
const PERIODS: Array<{ key: Period; label: string }> = [
  { key: 'week', label: t.community.periodWeek },
  { key: 'month', label: t.community.periodMonth },
  { key: 'all', label: t.community.periodAll },
];

export function RankingPage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const board = (params.get('board') as Board | null) ?? 'authors';
  const period = (params.get('period') as Period | null) ?? 'week';
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData(null);
    setError(null);
    try {
      const client = await getBrowseClient();
      setData(await client.leaderboard({ board, period }));
    } catch (e) {
      setError(friendlyError(e));
    }
  }, [board, period]);
  useEffect(() => { void load(); }, [load]);

  const setQuery = (next: Partial<{ board: Board; period: Period }>) => {
    const merged = { board, period, ...next };
    setParams(merged.board === 'authors' && merged.period === 'week' ? {} : { board: merged.board, period: merged.period }, { replace: true });
  };

  const rows = board === 'authors' ? data?.authors ?? [] : data?.novels ?? [];

  return (
    <div className="h-full overflow-y-auto bg-paper-50 dark:bg-paper-950">
      <div className="mx-auto max-w-3xl px-10 py-10">
        <header className="mb-6 flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-3xl font-semibold tracking-wide">{t.community.tabs.ranking}</h1>
            <p className="mt-1 text-sm text-ink-500">写得多、被读得多的人和故事</p>
          </div>
          <PublicTabs />
        </header>

        <div className="mb-6 flex flex-wrap items-center gap-3">
          <div className="inline-flex gap-1 rounded-full bg-paper-200/70 p-1 text-sm dark:bg-paper-900/70">
            {BOARDS.map((b) => (
              <button key={b.key} onClick={() => setQuery({ board: b.key })} className={cn('rounded-full px-4 py-1.5 transition', board === b.key ? 'bg-paper-0 font-medium text-ink-900 shadow-soft dark:bg-paper-800 dark:text-paper-50' : 'text-ink-500 hover:text-ink-800 dark:hover:text-paper-100')}>
                {b.label}
              </button>
            ))}
          </div>
          <div className="flex gap-1.5">
            {PERIODS.map((p) => (
              <button key={p.key} onClick={() => setQuery({ period: p.key })} className={cn('rounded-full px-3 py-1 text-xs transition', period === p.key ? 'bg-ink-800 text-paper-50 dark:bg-paper-100 dark:text-ink-900' : 'bg-paper-200/70 text-ink-600 hover:bg-paper-200 dark:bg-paper-800 dark:text-ink-300')}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {error ? (
          <div className="flex items-center justify-between gap-3 rounded-2xl bg-cinnabar-50 px-4 py-3 text-sm text-cinnabar-700 dark:bg-cinnabar-700/20 dark:text-cinnabar-100">
            <span>{error}</span>
            <Button size="sm" onClick={load}>{t.common.retry}</Button>
          </div>
        ) : !data ? (
          <div className="py-10 text-center text-sm text-ink-400"><Spinner className="mr-2" />{t.common.loading}</div>
        ) : rows.length === 0 ? (
          <EmptyState title={t.community.rankingEmpty} />
        ) : (
          <ol className="space-y-2">
            {board === 'authors'
              ? (data.authors ?? []).map((u) => (
                  <li key={u.id}>
                    <button onClick={() => nav(authorPath(u))} className="flex w-full items-center gap-4 rounded-2xl bg-paper-0 p-3 text-left shadow-soft transition hover:shadow-lift dark:bg-paper-900">
                      <Rank n={u.rank} />
                      <Avatar seed={u.handle || u.id} name={u.displayName} size="md" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-serif text-base font-semibold tracking-wide">{u.displayName}</span>
                          <LevelBadge level={u.level} />
                        </div>
                        <div className="truncate text-xs text-ink-400">@{u.handle} · {t.community.followers} {u.followerCount}</div>
                      </div>
                      <Points n={u.points} />
                    </button>
                  </li>
                ))
              : (data.novels ?? []).map((n) => (
                  <li key={n.id}>
                    <button onClick={() => nav(`/public/${n.id}`)} className="flex w-full items-center gap-4 rounded-2xl bg-paper-0 p-3 text-left shadow-soft transition hover:shadow-lift dark:bg-paper-900">
                      <Rank n={n.rank} />
                      <BookCover title={n.title} subtitle={n.author.displayName} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-serif text-base font-semibold tracking-wide">{n.title}</div>
                        <div className="truncate text-xs text-ink-400">{n.author.displayName} · {n.chapterCount} 章 · {n.charCount.toLocaleString()} 字</div>
                      </div>
                      <Points n={n.points} />
                    </button>
                  </li>
                ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function Rank({ n }: { n: number }) {
  return <span className={cn('w-8 shrink-0 text-center font-serif text-lg', n <= 3 ? 'text-cinnabar-600' : 'text-ink-400')}>{n}</span>;
}

function Points({ n }: { n: number }) {
  return <span className="shrink-0 font-serif text-sm text-ink-500">{n} {t.community.pointsUnit}</span>;
}
