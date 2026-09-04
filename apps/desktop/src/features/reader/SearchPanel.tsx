import { useState } from 'react';
import { Search } from 'lucide-react';
import { fmt, t } from '@/i18n/zh';
import { Input } from '@/components/ui';
import { searchPages, type DocumentRow } from '@/db/repos/documentsRepo';
import { useReader } from '@/stores/readerStore';

export function SearchPanel({ doc }: { doc: DocumentRow }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Array<{ pageNo: number; snippet: string }>>([]);
  const jumpTo = useReader((s) => s.jumpTo);
  const run = async () => { if (q.trim()) setHits(await searchPages(doc.id, q.trim())); };
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pb-3 pt-4">
        <div className="relative">
          <Search size={16} strokeWidth={1.75} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400" />
          <Input className="rounded-full pl-10" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} placeholder="在这本书里找…" />
        </div>
      </div>
      <ul className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-3">
        {hits.map((h, i) => (
          <li key={i}>
            <button className="w-full rounded-xl px-3 py-2 text-left text-sm leading-relaxed transition hover:bg-paper-200/60 dark:hover:bg-paper-800" onClick={() => jumpTo(h.pageNo)}>
              <span className="mr-2 font-serif text-[11px] tracking-wide text-ink-400">{fmt(t.reader.page, { n: h.pageNo })}</span>
              <span className="text-ink-700 dark:text-ink-300">…{h.snippet}…</span>
            </button>
          </li>
        ))}
        {q && hits.length === 0 && <li className="px-3 py-8 text-center font-serif text-xs text-ink-400">这本书里没有找到相关的文字</li>}
      </ul>
    </div>
  );
}
