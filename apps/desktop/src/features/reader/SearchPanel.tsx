import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { fmt, t } from '@/i18n/zh';
import { Button, Input, Spinner, cn } from '@/components/ui';
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
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const focusInput = () => {
    const el = boxRef.current?.querySelector('input');
    el?.focus();
    el?.select();
  };

  // 面板一出现、或再次按下 Cmd+F 时，把焦点放回输入框
  useEffect(() => { focusInput(); }, [focusNonce]);
  useEffect(() => { setQ(search.query); }, [search.query]);

  const run = async (raw: string) => {
    const query = raw.trim();
    if (!query) { clearSearch(); return; }
    setSearch({ query, running: true });
    const res = await searchPageTexts(doc.id, query, 400);
    const { hits, truncated, pages } = buildSearchHits(res.pages, query, MAX_HITS);
    setSearch({
      query, hits, pages, running: false,
      truncated: truncated || res.truncated,
      engine: res.engine,
      index: hits.length ? 0 : -1,
    });
    if (hits.length) useReader.getState().gotoHit(0);
  };

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [search.index]);

  const hasQuery = search.query.length > 0;

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 px-4 pb-3 pt-4">
        <div className="relative" ref={boxRef}>
          <Search size={16} strokeWidth={1.75} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400" />
          <Input
            className="rounded-full pl-10 pr-9"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); if (q.trim() === search.query && search.hits.length) stepSearch(e.shiftKey ? -1 : 1); else void run(q); }
              if (e.key === 'Escape') { setQ(''); clearSearch(); }
            }}
            placeholder="在这本书里找…"
          />
          {q && (
            <button className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700" onClick={() => { setQ(''); clearSearch(); focusInput(); }} title="清空">
              <X size={14} strokeWidth={1.75} />
            </button>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 px-1">
          <span className="font-serif text-[11px] text-ink-400">
            {search.running ? '正在找…'
              : hasQuery
                ? search.hits.length
                  ? `第 ${search.index + 1} / ${search.hits.length} 条 · ${search.pages} 页${search.truncated ? ` · 只显示前 ${MAX_HITS} 条` : ''}`
                  : '没有找到'
                : indexing?.status === 'running'
                  ? `正在提取文本 ${indexing.done}/${indexing.total || '…'}，建好之前搜不全`
                  : `共 ${doc.pageCount} 页`}
          </span>
          <div className="flex gap-0.5">
            <Button size="sm" variant="ghost" title="上一条 (⌘⇧G)" disabled={search.hits.length === 0} onClick={() => stepSearch(-1)}><ChevronUp size={14} strokeWidth={1.75} /></Button>
            <Button size="sm" variant="ghost" title="下一条 (⌘G)" disabled={search.hits.length === 0} onClick={() => stepSearch(1)}><ChevronDown size={14} strokeWidth={1.75} /></Button>
          </div>
        </div>
      </div>
      {search.running && <div className="flex justify-center py-6"><Spinner /></div>}
      <ul ref={listRef} className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-3 scrollbar-thin">
        {search.hits.map((h, i) => (
          <li key={`${h.pageNo}-${h.occurrence}`}>
            <button
              data-active={i === search.index}
              className={cn(
                'w-full rounded-xl px-3 py-2 text-left text-sm leading-relaxed transition',
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
        {hasQuery && !search.running && search.hits.length === 0 && (
          <li className="px-3 py-8 text-center font-serif text-xs leading-relaxed text-ink-400">
            这本书里没有找到相关的文字
            {indexing?.status === 'running' && <><br />（文本还在提取中，稍后再试试）</>}
          </li>
        )}
      </ul>
    </div>
  );
}
