import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { fmt, t } from '@/i18n';
import { Button, IconButton, Input, Spinner, cn } from '@/components/ui';
import { useAsyncData } from '@/components/data/useAsyncData';
import { searchPageTexts, type DocumentRow } from '@/db/repos/documentsRepo';
import { buildSearchHits } from '@/documents/search';
import { useIndexQueue } from '@/documents/indexQueue';
import { useReader } from '@/stores/readerStore';

const MAX_HITS = 500;

export function SearchPanel({ doc }: { doc: DocumentRow }) {
  const search = useReader((s) => s.search);
  const setSearch = useReader((s) => s.setSearch);
  const gotoHit = useReader((s) => s.gotoHit);
  const stepSearch = useReader((s) => s.stepSearch);
  const clearSearch = useReader((s) => s.clearSearch);
  const indexing = useIndexQueue((s) => s.tasks[doc.id]);
  const focusNonce = useReader((s) => s.searchFocusNonce);
  const [q, setQ] = useState(search.query);
  // 真正提交去检索的词；它一变，数据层就重取一次（并把上一发掐掉）。
  // 初始为空：面板来回切换时沿用 store 里已有的结果，不重新检索、也不把光标弹回第一条。
  const [submitted, setSubmitted] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const focusInput = () => {
    const el = boxRef.current?.querySelector('input');
    el?.focus();
    el?.select();
  };

  // 检索本身是一次性取数：卸载取消、乱序丢弃、并发去重都交给数据层
  const result = useAsyncData(async () => {
    const res = await searchPageTexts(doc.id, submitted, 400);
    const built = buildSearchHits(res.pages, submitted, MAX_HITS);
    // 把检索词一并带回来：写 store 时用它，免得依赖渲染时的 submitted 而写串
    return { ...built, query: submitted, truncated: built.truncated || res.truncated, engine: res.engine };
  }, { key: `readerSearch:${doc.id}:${submitted}`, enabled: submitted.trim().length > 0 });

  // 结果落到 store：页面高亮层与快捷键（⌘G）都从那里读
  useEffect(() => {
    const data = result.data;
    if (!data) return;
    setSearch({
      query: data.query, hits: data.hits, pages: data.pages,
      truncated: data.truncated, engine: data.engine,
      index: data.hits.length ? 0 : -1,
    });
    if (data.hits.length) useReader.getState().gotoHit(0);
  }, [result.data]);

  // store 里的 running 只做展示，跟着数据层的 loading 走，别再各记一份
  useEffect(() => { setSearch({ running: result.loading }); }, [result.loading, setSearch]);

  const submit = (raw: string) => {
    const query = raw.trim();
    if (!query) { setSubmitted(''); clearSearch(); return; }
    setSubmitted(query);
  };

  const reset = () => { setQ(''); setSubmitted(''); clearSearch(); };

  // 面板一出现、或再次按下 Cmd+F 时，把焦点放回输入框
  useEffect(() => { focusInput(); }, [focusNonce]);
  useEffect(() => { setQ(search.query); }, [search.query]);

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [search.index]);

  const hasQuery = search.query.length > 0;
  const status = result.loading ? t.reader.searching
    : hasQuery
      ? search.hits.length
        ? fmt(t.reader.hitPosition, { i: search.index + 1, n: search.hits.length, pages: search.pages })
          + (search.truncated ? fmt(t.reader.hitTruncated, { n: MAX_HITS }) : '')
        : t.reader.noHits
      : indexing?.status === 'running'
        ? fmt(t.reader.indexingPartial, { done: indexing.done, total: indexing.total || '…' })
        : fmt(t.reader.pageTotal, { n: doc.pageCount });

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 px-4 pb-3 pt-4">
        <div className="relative" ref={boxRef}>
          <Search size={16} strokeWidth={1.75} aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400" />
          <Input
            className="rounded-full pl-10 pr-9"
            value={q}
            aria-label={t.reader.searchInDoc}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (q.trim() === search.query && search.hits.length) stepSearch(e.shiftKey ? -1 : 1);
                else submit(q);
              }
              if (e.key === 'Escape') reset();
            }}
            placeholder={t.reader.searchPlaceholder}
          />
          {q && (
            <IconButton
              label={t.reader.clear}
              className="absolute right-2 top-1/2 -translate-y-1/2"
              onClick={() => { reset(); focusInput(); }}
            >
              <X size={14} strokeWidth={1.75} aria-hidden="true" />
            </IconButton>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 px-1">
          <span role="status" aria-live="polite" className="font-serif text-[11px] text-ink-400">{status}</span>
          <div className="flex gap-0.5">
            <Button size="sm" variant="ghost" title={t.reader.prevHit} aria-label={t.reader.prevHit} disabled={search.hits.length === 0} onClick={() => stepSearch(-1)}><ChevronUp size={14} strokeWidth={1.75} aria-hidden="true" /></Button>
            <Button size="sm" variant="ghost" title={t.reader.nextHit} aria-label={t.reader.nextHit} disabled={search.hits.length === 0} onClick={() => stepSearch(1)}><ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" /></Button>
          </div>
        </div>
        {result.error != null && (
          <p role="alert" className="px-1 font-serif text-[11px] leading-relaxed text-cinnabar-600">
            {fmt(t.reader.searchFailed, { message: result.error instanceof Error ? result.error.message : String(result.error) })}
          </p>
        )}
      </div>
      {result.loading && <div className="flex justify-center py-6"><Spinner /></div>}
      <ul ref={listRef} aria-label={t.reader.searchResults} className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-3 scrollbar-thin">
        {search.hits.map((h, i) => (
          <li key={`${h.pageNo}-${h.occurrence}`}>
            <button
              data-active={i === search.index}
              aria-current={i === search.index ? 'true' : undefined}
              className={cn(
                'w-full rounded-xl px-3 py-2 text-left text-sm leading-relaxed transition focus:outline-none focus-visible:ring-2 focus-visible:ring-tea-500/50',
                i === search.index ? 'bg-tea-500/10 text-ink-800 dark:bg-tea-500/15 dark:text-paper-100' : 'hover:bg-paper-200/60 dark:hover:bg-paper-800',
              )}
              onClick={() => gotoHit(i)}
            >
              <span className="mr-2 font-serif text-[11px] tracking-wide text-ink-400">{fmt(t.reader.page, { n: h.pageNo })}</span>
              <span className="text-ink-700 dark:text-ink-300">
                …{h.snippet.slice(0, h.snippetStart)}
                <mark className="rounded-sm bg-amber-300/70 px-0.5 text-ink-900 dark:bg-amber-400/50 dark:text-paper-50">{h.snippet.slice(h.snippetStart, h.snippetEnd)}</mark>
                {h.snippet.slice(h.snippetEnd)}…
              </span>
            </button>
          </li>
        ))}
        {hasQuery && !result.loading && search.hits.length === 0 && (
          <li className="px-3 py-8 text-center font-serif text-xs leading-relaxed text-ink-400">
            {t.reader.noHitsDetail}
            {indexing?.status === 'running' && <><br />{t.reader.stillIndexing}</>}
          </li>
        )}
      </ul>
    </div>
  );
}
