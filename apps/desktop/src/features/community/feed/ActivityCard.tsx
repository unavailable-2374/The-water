import { Link, useNavigate } from 'react-router';
import type { FeedItem } from '@the-water/shared';
import { activityVerb } from '@/community/feedText';
import { fmt, t } from '@/i18n';
import { Badge, BookCover, cn } from '@/components/ui';
import { UserChip } from '@/components/UserChip';

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return t.community.justNow;
  if (min < 60) return fmt(t.community.minutesAgo, { n: min });
  const hour = Math.floor(min / 60);
  if (hour < 24) return fmt(t.community.hoursAgo, { n: hour });
  const day = Math.floor(hour / 24);
  if (day < 30) return fmt(t.community.daysAgo, { n: day });
  return new Date(iso).toLocaleDateString();
}

/** 一条动态：谁、做了什么、哪本书。 */
export function ActivityCard({ item }: { item: FeedItem }) {
  const nav = useNavigate();
  const verb = activityVerb(item);
  return (
    <li>
      {/*
        整卡可点，但卡里还嵌着作者链接和来源链接，用原生 <button> 会出现
        「按钮里套链接」的非法嵌套，所以走 role=button：自己补 Tab 序列、
        Enter/Space、焦点环和无障碍名字。
      */}
      <div
        role="button"
        tabIndex={0}
        aria-label={fmt(t.publicArea.openNovel, { title: item.novel.title })}
        onClick={() => nav(`/public/${item.novel.id}`)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            nav(`/public/${item.novel.id}`);
          }
        }}
        className="flex cursor-pointer items-start gap-4 rounded-2xl bg-paper-0 p-4 shadow-soft transition hover:shadow-lift focus:outline-none focus-visible:ring-2 focus-visible:ring-tea-500/50 dark:bg-paper-900"
      >
        <UserChip user={item.actor} size="sm" showHandle={false} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm text-ink-600 dark:text-ink-300">
            {verb}
            <span className="ml-1 text-[11px] text-ink-400">{relativeTime(item.createdAt)}</span>
          </div>
          <div className="mt-2 flex gap-3">
            <BookCover title={item.novel.title} subtitle={item.actor.displayName} size="sm" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="truncate font-serif text-base font-semibold tracking-wide text-ink-900 dark:text-paper-100">{item.novel.title}</span>
                {item.novel.isDerivative && <Badge tone="amber">{t.community.derivative}</Badge>}
                {item.kind === 'novel_completed' && <Badge tone="green" dot>{t.publicArea.statusCompleted}</Badge>}
              </div>
              {item.source && (
                <div className="mt-0.5 text-xs text-ink-400">
                  {t.publicArea.adaptedFrom}
                  {item.source.visibility === 'unavailable' ? <span>{item.source.title}</span> : <Link to={`/public/${item.source.id}`} onClick={(e) => e.stopPropagation()} className="hover:text-tea-700">《{item.source.title}》</Link>}
                </div>
              )}
              <p className={cn('mt-1 line-clamp-2 text-sm leading-relaxed text-ink-500', !item.novel.summary && 'text-ink-400')}>
                {item.version?.changeNote || item.novel.summary || t.publicArea.noSummary}
              </p>
              <div className="mt-1.5 font-serif text-[11px] text-ink-400">
                {fmt(t.publicArea.chapterCount, { n: item.novel.chapterCount })} · {fmt(t.publicArea.charCount, { n: item.novel.charCount.toLocaleString() })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}
