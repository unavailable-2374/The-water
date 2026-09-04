import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Compass, Eye, GitFork, Heart, LogIn, Search, Settings2, X } from 'lucide-react';
import { LICENSE_LABELS, type BrowseQuery, type NovelSummary } from '@the-water/shared';
import { t } from '@/i18n/zh';
import { BookCover, Button, EmptyState, Input, Spinner, cn } from '@/components/ui';
import { Avatar } from '@/components/Avatar';
import { authorPath } from '@/components/UserChip';
import { PublicTabs } from './PublicTabs';
import { useLoginGate } from './useLoginGate';
import { useAccount } from '@/stores/accountStore';
import { getBrowseClient } from '@/sync/account';
import { describeError } from '@/sync/api';

type Sort = BrowseQuery['sort'];
const SORTS: Array<{ value: Sort; label: string }> = [
  { value: 'latest', label: '最新上架' },
  { value: 'popular', label: '最多人读' },
  { value: 'likes', label: '最多喜欢' },
  { value: 'forks', label: '最多二创' },
];

function Chip({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button type="button" title={title} onClick={onClick} className={cn('inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs transition', active ? 'bg-ink-800 text-paper-50 dark:bg-paper-100 dark:text-ink-900' : 'bg-paper-200/70 text-ink-600 hover:bg-paper-200 hover:text-ink-900 dark:bg-paper-800 dark:text-ink-300 dark:hover:bg-paper-800/80 dark:hover:text-paper-100')}>
      {children}
    </button>
  );
}

export function BrowsePage() {
  const nav = useNavigate();
  const { account, loaded, refresh } = useAccount();
  const { openLogin, loginDialog } = useLoginGate('登录云端账号，才能喜欢、发布和二创');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('latest');
  const [tagInput, setTagInput] = useState('');
  const [tag, setTag] = useState('');
  const [originalsOnly, setOriginalsOnly] = useState(false);
  const [allowDerivatives, setAllowDerivatives] = useState(false);
  const [items, setItems] = useState<NovelSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (!loaded) void refresh(); }, [loaded, refresh]);

  const load = async (append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const client = await getBrowseClient();
      const page = await client.listNovels({
        sort, q: q || undefined, tag: tag || undefined,
        originalsOnly: originalsOnly || undefined, allowDerivatives: allowDerivatives || undefined,
        cursor: append && cursor ? cursor : undefined, limit: 20,
      });
      setItems((prev) => (append ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (e) {
      setError(describeError(e));
      if (!append) setItems([]);
    } finally {
      setLoading(false);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(false); }, [q, sort, tag, originalsOnly, allowDerivatives, account?.userId, account?.serverUrl]);

  const applySearch = () => { setQ(qInput.trim()); setTag(tagInput.trim()); };

  return (
    <div className="h-full overflow-y-auto bg-paper-50 dark:bg-paper-950">
      <div className="mx-auto max-w-6xl px-10 py-10">
        <header className="mb-6 flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-3xl font-semibold tracking-wide">{t.nav.public}</h1>
            <p className="mt-1 text-sm text-ink-500">别人写下的故事，也许正是你想看的</p>
          </div>
          <div className="flex items-center gap-2">
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
                <Button size="sm" variant="primary" onClick={openLogin}><LogIn size={16} strokeWidth={1.75} />{t.publicArea.login}</Button>
              </>
            )}
            <Button size="sm" variant="ghost" className="px-2" title="账号设置" onClick={() => nav('/settings/account')}><Settings2 size={16} strokeWidth={1.75} /></Button>
          </div>
        </header>

        <div className="mb-8 space-y-3">
          <div className="flex items-center gap-2">
            <div className="relative min-w-[240px] flex-1">
              <Search size={16} strokeWidth={1.75} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400" />
              <Input className="rounded-full pl-10" value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="找一本书：书名或简介里的字…" maxLength={50} onKeyDown={(e) => { if (e.key === 'Enter') applySearch(); }} />
            </div>
            <Input className="max-w-[150px] rounded-full" value={tagInput} onChange={(e) => setTagInput(e.target.value)} placeholder="标签" maxLength={20} onKeyDown={(e) => { if (e.key === 'Enter') applySearch(); }} />
            <Button className="rounded-full" onClick={applySearch}>{t.common.search}</Button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {SORTS.map((s) => <Chip key={s.value} active={sort === s.value} onClick={() => setSort(s.value)}>{s.label}</Chip>)}
            <span className="mx-1 h-4 w-px bg-paper-300 dark:bg-paper-800" />
            <Chip active={originalsOnly} onClick={() => setOriginalsOnly(!originalsOnly)}>只看原创</Chip>
            <Chip active={allowDerivatives} onClick={() => setAllowDerivatives(!allowDerivatives)}>欢迎二创</Chip>
            {tag && (
              <button className="inline-flex items-center gap-1 rounded-full bg-tea-50 px-3 py-1 text-xs text-tea-700 hover:bg-tea-100 dark:bg-tea-800/40 dark:text-tea-200" onClick={() => { setTag(''); setTagInput(''); }} title="去掉这个标签">
                #{tag}<X size={12} strokeWidth={1.75} />
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-6 flex items-center justify-between gap-3 rounded-2xl bg-cinnabar-50 px-4 py-3 text-sm text-cinnabar-700 dark:bg-cinnabar-700/20 dark:text-cinnabar-100">
            <span>{error}</span>
            <Button size="sm" onClick={() => load(false)}>{t.common.retry}</Button>
          </div>
        )}
        {items.length === 0 && !loading ? (
          !error && <EmptyState icon={<Compass size={40} strokeWidth={1.25} />} title="书房里还没有这样的故事" description="换个关键词试试，或者把你写的故事发布上来，让别人也读到。" />
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-8 gap-y-10">
            {items.map((n) => <NovelCard key={n.id} novel={n} onOpen={() => nav(`/public/${n.id}`)} onTag={(tg) => { setTag(tg); setTagInput(tg); }} />)}
          </ul>
        )}
        <div className="mt-10 flex justify-center">
          {loading ? <Spinner /> : cursor ? <Button onClick={() => load(true)}>再看一些</Button> : items.length > 0 ? <span className="font-serif text-xs text-ink-400">— 已经翻到底了 —</span> : null}
        </div>

        {loginDialog}
      </div>
    </div>
  );
}

export function NovelCard({ novel: n, onOpen, onTag }: { novel: NovelSummary; onOpen: () => void; onTag?: (tag: string) => void }) {
  return (
    <li className="group relative">
      <button className="block w-full text-left" onClick={onOpen} title={n.summary || undefined}>
        <BookCover title={n.title} subtitle={n.author.displayName} size="md" className="mx-auto transition-transform duration-200 group-hover:-translate-y-1" />
        <div className="mt-3 line-clamp-2 text-center font-serif text-sm leading-snug text-ink-800 dark:text-paper-100">{n.title}</div>
      </button>
      <div className="mt-1 text-center text-[11px] text-ink-400">
        <Link to={authorPath(n.author)} className="hover:text-tea-700 dark:hover:text-tea-200">{n.author.displayName}</Link>
        {' · '}{n.writingStatus === 'completed' ? '完结' : '连载'}{n.isDerivative ? ' · 二创' : ''}
      </div>
      <button className="block w-full text-left" onClick={onOpen} title={n.summary || undefined}>
        <div className="mt-1 flex items-center justify-center gap-2.5 font-serif text-[11px] text-ink-400" title={`${LICENSE_LABELS[n.license]}${n.allowDerivatives ? ' · 欢迎二创' : ''}`}>
          <span className="inline-flex items-center gap-0.5"><Eye size={11} strokeWidth={1.75} />{n.viewCount}</span>
          <span className="inline-flex items-center gap-0.5"><Heart size={11} strokeWidth={1.75} />{n.likeCount}</span>
          <span className="inline-flex items-center gap-0.5"><GitFork size={11} strokeWidth={1.75} />{n.forkCount}</span>
          <span>{n.chapterCount} 章</span>
        </div>
      </button>
      {n.tags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap justify-center gap-1">
          {n.tags.slice(0, 3).map((tg) => (
            <button key={tg} onClick={() => onTag?.(tg)} className="rounded-full bg-paper-200/70 px-2 py-0.5 text-[10px] text-ink-500 transition hover:bg-tea-50 hover:text-tea-700 dark:bg-paper-800 dark:text-ink-300 dark:hover:bg-tea-800/40 dark:hover:text-tea-200">#{tg}</button>
          ))}
        </div>
      )}
    </li>
  );
}

export function shortLicense(license: NovelSummary['license']): string {
  return license === 'all-rights-reserved' ? '保留所有权利' : license === 'cc0' ? 'CC0' : license.toUpperCase();
}
