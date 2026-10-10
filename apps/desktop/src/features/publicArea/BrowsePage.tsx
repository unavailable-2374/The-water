import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Compass, Eye, GitFork, Heart, LogIn, Search, Settings2, X } from 'lucide-react';
import { LICENSE_LABELS, type BrowseQuery, type NovelSummary } from '@the-water/shared';
import { fmt, t } from '@/i18n';
import { BookCover, Button, EmptyState, IconButton, Input, Spinner, cn } from '@/components/ui';
import { usePagedList } from '@/components/data/useAsyncData';
import { Avatar } from '@/components/Avatar';
import { authorPath } from '@/components/UserChip';
import { PublicTabs } from './PublicTabs';
import { useLoginGate } from './useLoginGate';
import { useAccount } from '@/stores/accountStore';
import { getBrowseClient } from '@/sync/account';
import { friendlyError } from '@/community/errors';

type Sort = BrowseQuery['sort'];

/** 写成函数而不是模块顶层常量表：`t` 是惰性代理，常量表会把文案固定在旧语言上。 */
function sorts(): Array<{ value: Sort; label: string }> {
  return [
    { value: 'latest', label: t.publicArea.sortLatest },
    { value: 'popular', label: t.publicArea.sortPopular },
    { value: 'likes', label: t.publicArea.sortLikes },
    { value: 'forks', label: t.publicArea.sortForks },
  ];
}

function Chip({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button type="button" title={title} aria-pressed={active} onClick={onClick} className={cn('inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs transition', active ? 'bg-ink-800 text-paper-50 dark:bg-paper-100 dark:text-ink-900' : 'bg-paper-200/70 text-ink-600 hover:bg-paper-200 hover:text-ink-900 dark:bg-paper-800 dark:text-ink-300 dark:hover:bg-paper-800/80 dark:hover:text-paper-100')}>
      {children}
    </button>
  );
}

export function BrowsePage() {
  const nav = useNavigate();
  const { account, loaded, refresh } = useAccount();
  const { openLogin, loginDialog } = useLoginGate(t.publicArea.loginGateBrowse);
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('latest');
  const [tagInput, setTagInput] = useState('');
  const [tag, setTag] = useState('');
  const [originalsOnly, setOriginalsOnly] = useState(false);
  const [allowDerivatives, setAllowDerivatives] = useState(false);

  useEffect(() => { if (!loaded) void refresh(); }, [loaded, refresh]);

  const query: Partial<BrowseQuery> = {
    sort, q: q || undefined, tag: tag || undefined,
    originalsOnly: originalsOnly || undefined, allowDerivatives: allowDerivatives || undefined,
  };
  const { items, initializing, loadingMore, error, hasMore, reload, loadMore } = usePagedList<NovelSummary>(
    async ({ cursor }) => {
      const client = await getBrowseClient();
      const page = await client.listNovels({ ...query, cursor: cursor ?? undefined, limit: 20 });
      return { items: page.items, nextCursor: page.nextCursor };
    },
    // 登录态也要拼进 key：换了账号或服务器，看到的书房就不是同一个。
    { key: JSON.stringify({ ...query, user: account?.userId, server: account?.serverUrl }) },
  );

  const applySearch = () => { setQ(qInput.trim()); setTag(tagInput.trim()); };

  return (
    <div className="h-full overflow-y-auto bg-paper-50 dark:bg-paper-950">
      <div className="mx-auto max-w-6xl px-6 py-10 lg:px-12 lg:py-12">
        <header className="mb-8 flex flex-wrap items-end justify-between gap-5">
          <div>
            <h1 className="page-heading text-[32px] font-bold leading-tight">{t.nav.public}</h1>
            <p className="mt-2 text-sm text-ink-500">{t.publicArea.browseSubtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <PublicTabs />
            {account ? (
              <button
                className="inline-flex items-center gap-1.5 rounded-full bg-paper-200/70 py-1 pl-1 pr-3 text-xs text-ink-700 transition hover:bg-paper-200 dark:bg-paper-800 dark:text-ink-200 dark:hover:bg-paper-800/80"
                onClick={() => nav(account.handle ? authorPath({ id: account.userId, handle: account.handle }) : '/settings/account')}
                title={account.serverUrl}
              >
                <Avatar seed={account.handle || account.userId} name={account.displayName} size="xs" />
                {account.displayName}
              </button>
            ) : (
              <>
                <span className="text-xs text-ink-400">{t.publicArea.notLoggedIn}</span>
                <Button size="sm" variant="primary" onClick={openLogin}><LogIn size={16} strokeWidth={1.75} aria-hidden="true" />{t.publicArea.login}</Button>
              </>
            )}
            <IconButton label={t.publicArea.accountSettings} onClick={() => nav('/settings/account')}>
              <Settings2 size={16} strokeWidth={1.75} aria-hidden="true" />
            </IconButton>
          </div>
        </header>

        <div className="mb-8 space-y-3">
          <div className="flex items-center gap-2">
            <div className="relative min-w-[240px] flex-1">
              <Search size={16} strokeWidth={1.75} aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400" />
              <Input className="rounded-full pl-10" aria-label={t.common.search} value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder={t.publicArea.searchPlaceholder} maxLength={50} onKeyDown={(e) => { if (e.key === 'Enter') applySearch(); }} />
            </div>
            <Input className="max-w-[150px] rounded-full" aria-label={t.publicArea.tagPlaceholder} value={tagInput} onChange={(e) => setTagInput(e.target.value)} placeholder={t.publicArea.tagPlaceholder} maxLength={20} onKeyDown={(e) => { if (e.key === 'Enter') applySearch(); }} />
            <Button className="rounded-full" onClick={applySearch}>{t.common.search}</Button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t.publicArea.sortLabel}>
            {sorts().map((s) => <Chip key={s.value} active={sort === s.value} onClick={() => setSort(s.value)}>{s.label}</Chip>)}
            <span aria-hidden="true" className="mx-1 h-4 w-px bg-paper-300 dark:bg-paper-800" />
            <Chip active={originalsOnly} onClick={() => setOriginalsOnly(!originalsOnly)}>{t.publicArea.onlyOriginals}</Chip>
            <Chip active={allowDerivatives} onClick={() => setAllowDerivatives(!allowDerivatives)}>{t.publicArea.welcomeDerivatives}</Chip>
            {tag && (
              <button className="inline-flex items-center gap-1 rounded-full bg-tea-50 px-3 py-1 text-xs text-tea-700 hover:bg-tea-100 dark:bg-tea-800/40 dark:text-tea-200" onClick={() => { setTag(''); setTagInput(''); }} title={t.publicArea.removeTag} aria-label={t.publicArea.removeTag}>
                #{tag}<X size={12} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        {error !== null && (
          <div role="alert" className="mb-6 flex items-center justify-between gap-3 rounded-2xl bg-cinnabar-50 px-4 py-3 text-sm text-cinnabar-700 dark:bg-cinnabar-700/20 dark:text-cinnabar-100">
            <span>{friendlyError(error)}</span>
            <Button size="sm" onClick={reload}>{t.common.retry}</Button>
          </div>
        )}
        {initializing ? (
          <div role="status" className="py-10 text-center text-sm text-ink-400"><Spinner className="mr-2" />{t.common.loading}</div>
        ) : items.length === 0 ? (
          error === null && <EmptyState icon={<Compass size={40} strokeWidth={1.25} aria-hidden="true" />} title={t.publicArea.browseEmptyTitle} description={t.publicArea.browseEmptyDesc} />
        ) : (
          <ul aria-label={t.publicArea.novelListLabel} className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-8 gap-y-10">
            {items.map((n) => <NovelCard key={n.id} novel={n} onOpen={() => nav(`/public/${n.id}`)} onTag={(tg) => { setTag(tg); setTagInput(tg); }} />)}
          </ul>
        )}
        <div className="mt-10 flex justify-center" aria-live="polite">
          {loadingMore ? <Spinner /> : hasMore ? <Button onClick={loadMore}>{t.common.more}</Button> : items.length > 0 ? <span className="font-serif text-xs text-ink-400">{t.common.reachedEnd}</span> : null}
        </div>

        {loginDialog}
      </div>
    </div>
  );
}

export function NovelCard({ novel: n, onOpen, onTag }: { novel: NovelSummary; onOpen: () => void; onTag?: (tag: string) => void }) {
  const open = fmt(t.publicArea.openNovel, { title: n.title });
  return (
    <li className="group relative">
      <button className="block w-full text-left" onClick={onOpen} title={n.summary || undefined} aria-label={open}>
        <BookCover title={n.title} subtitle={n.author.displayName} size="md" className="mx-auto transition-transform duration-200 group-hover:-translate-y-1" />
        <div className="mt-3 line-clamp-2 text-center font-serif text-sm leading-snug text-ink-800 dark:text-paper-100">{n.title}</div>
      </button>
      <div className="mt-1 text-center text-[11px] text-ink-400">
        <Link to={authorPath(n.author)} className="hover:text-tea-700 dark:hover:text-tea-200">{n.author.displayName}</Link>
        {' · '}{n.writingStatus === 'completed' ? t.publicArea.shortCompleted : t.publicArea.shortOngoing}{n.isDerivative ? ` · ${t.community.derivative}` : ''}
      </div>
      <button className="block w-full text-left" onClick={onOpen} title={n.summary || undefined} aria-label={open}>
        <div className="mt-1 flex items-center justify-center gap-2.5 font-serif text-[11px] text-ink-400" title={`${LICENSE_LABELS[n.license]}${n.allowDerivatives ? ` · ${t.publicArea.welcomeDerivatives}` : ''}`}>
          <span className="inline-flex items-center gap-0.5"><Eye size={11} strokeWidth={1.75} aria-hidden="true" />{n.viewCount}</span>
          <span className="inline-flex items-center gap-0.5"><Heart size={11} strokeWidth={1.75} aria-hidden="true" />{n.likeCount}</span>
          <span className="inline-flex items-center gap-0.5"><GitFork size={11} strokeWidth={1.75} aria-hidden="true" />{n.forkCount}</span>
          <span>{fmt(t.publicArea.chapterCount, { n: n.chapterCount })}</span>
        </div>
      </button>
      {n.tags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap justify-center gap-1">
          {n.tags.slice(0, 3).map((tg) => (
            <button key={tg} onClick={() => onTag?.(tg)} aria-label={fmt(t.publicArea.filterByTag, { tag: tg })} className="rounded-full bg-paper-200/70 px-2 py-0.5 text-[10px] text-ink-500 transition hover:bg-tea-50 hover:text-tea-700 dark:bg-paper-800 dark:text-ink-300 dark:hover:bg-tea-800/40 dark:hover:text-tea-200">#{tg}</button>
          ))}
        </div>
      )}
    </li>
  );
}

export function shortLicense(license: NovelSummary['license']): string {
  return license === 'all-rights-reserved' ? t.publicArea.licenseAllRights : license === 'cc0' ? 'CC0' : license.toUpperCase();
}
