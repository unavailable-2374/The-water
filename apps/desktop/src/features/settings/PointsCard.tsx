import { useCallback, useEffect, useState } from 'react';
import { BADGE_BY_ID, LEVELS, type MyPointsResponse } from '@the-water/shared';
import { t, fmt } from '@/i18n';
import { Badge, Button, Card, SectionTitle, Spinner } from '@/components/ui';
import { levelView } from '@/community/level';
import { friendlyError } from '@/community/errors';
import { getClient } from '@/sync/account';
import { LevelBadge } from '@/features/community/LevelBadge';

/** 设置页里的积分卡：等级进度、徽章、最近的加分记录。 */
export function PointsCard() {
  const [data, setData] = useState<MyPointsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const client = await getClient();
      if (!client) return;
      setData(await client.myPoints({ limit: 10 }));
    } catch (e) {
      setError(friendlyError(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error) {
    return (
      <section>
        <SectionTitle>{t.community.points}</SectionTitle>
        <Card className="flex items-center justify-between gap-3 text-sm text-ink-500" role="alert">
          <span>{error}</span>
          <Button size="sm" onClick={load}>{t.common.retry}</Button>
        </Card>
      </section>
    );
  }
  if (!data) {
    return (
      <section>
        <SectionTitle>{t.community.points}</SectionTitle>
        <Card><div className="text-sm text-ink-400" role="status"><Spinner className="mr-2" />{t.common.loading}</div></Card>
      </section>
    );
  }

  const view = levelView(data.points, data.level);
  const nextLevel = data.level.next === null ? null : LEVELS.find((l) => l.min === data.level.next);
  return (
    <section>
      <SectionTitle action={<span className="font-serif text-sm text-ink-500">{data.points} {t.community.pointsUnit}</span>}>{t.community.points}</SectionTitle>
      <Card className="space-y-5">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <LevelBadge level={data.level} />
            <span className="font-serif text-xs text-ink-400">
              {view.remaining === null || !nextLevel
                ? t.community.topLevel
                : fmt(t.community.pointsTo, { n: nextLevel.level, title: nextLevel.title, remaining: view.remaining })}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-paper-200 dark:bg-paper-800">
            <div className="h-full rounded-full bg-tea-500 transition-all" style={{ width: `${Math.round(view.ratio * 100)}%` }} />
          </div>
        </div>

        <div>
          <div className="mb-2 font-serif text-xs tracking-[0.2em] text-ink-400">{t.community.badges}</div>
          {data.badges.length === 0 ? (
            <p className="text-sm text-ink-400">{t.community.noBadges}</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {data.badges.map((b) => (
                <Badge key={b.id} tone="green" className="cursor-default" >
                  <span title={BADGE_BY_ID[b.id]?.description}>{BADGE_BY_ID[b.id]?.name ?? b.id}</span>
                </Badge>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="mb-2 font-serif text-xs tracking-[0.2em] text-ink-400">{t.community.ledger}</div>
          {data.ledger.items.length === 0 ? (
            <p className="text-sm text-ink-400">{t.community.ledgerEmpty}</p>
          ) : (
            <ul className="space-y-1.5" aria-label={t.community.ledger}>
              {data.ledger.items.map((e) => (
                <li key={e.id} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="truncate text-ink-600 dark:text-ink-300">{e.label}</span>
                  <span className="shrink-0 font-serif text-xs text-ink-400">{new Date(e.createdAt).toLocaleDateString()}</span>
                  <span className="w-12 shrink-0 text-right font-serif text-tea-700 dark:text-tea-200">{e.points > 0 ? `+${e.points}` : e.points}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </section>
  );
}
