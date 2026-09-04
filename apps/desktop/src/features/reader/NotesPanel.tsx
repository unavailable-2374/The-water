import { useState } from 'react';
import { Trash2, Pencil, Check } from 'lucide-react';
import { fmt, t } from '@/i18n/zh';
import { Button, EmptyState, Textarea } from '@/components/ui';
import type { DocumentRow } from '@/db/repos/documentsRepo';
import { deleteHighlight, updateHighlight, type Highlight } from '@/db/repos/highlightsRepo';
import { useReader } from '@/stores/readerStore';

export function NotesPanel({ doc: _doc }: { doc: DocumentRow }) {
  const highlights = useReader((s) => s.highlights);
  const refresh = useReader((s) => s.refreshHighlights);
  const jumpTo = useReader((s) => s.jumpTo);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const byPage = new Map<number, Highlight[]>();
  for (const h of highlights) byPage.set(h.pageNo, [...(byPage.get(h.pageNo) ?? []), h]);

  const saveEdit = async (h: Highlight) => {
    await updateHighlight(h.id, { noteText: draft, kind: draft ? 'note' : h.kind });
    setEditing(null);
    await refresh();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-baseline gap-2 px-5 pb-2 pt-4">
        <span className="font-serif text-sm font-semibold tracking-wide text-ink-800 dark:text-paper-100">我的笔记</span>
        <span className="font-serif text-xs text-ink-400">{highlights.length} 条</span>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {highlights.length === 0 ? (
          <EmptyState title="还没有笔记" description="在书页上选一段文字，把它划下来，或写下此刻的想法。" />
        ) : (
          [...byPage.entries()].sort((a, b) => a[0] - b[0]).map(([page, list]) => (
            <div key={page} className="mb-5">
              <div className="mb-2 px-1 font-serif text-[11px] tracking-widest text-ink-400">{fmt(t.reader.page, { n: page })}</div>
              <ul className="space-y-2">
                {list.map((h) => (
                  <li key={h.id} className="group rounded-2xl bg-paper-0 p-3.5 shadow-soft transition hover:shadow-lift dark:bg-paper-800">
                    <button className="block w-full text-left" onClick={() => jumpTo(h.pageNo, h.id)}>
                      <p className="line-clamp-3 border-l-2 border-tea-500/60 pl-3 font-serif text-[13px] leading-relaxed text-ink-600 dark:text-ink-300">{h.anchor.exact}</p>
                    </button>
                    {editing === h.id ? (
                      <div className="mt-2.5 space-y-1.5">
                        <Textarea rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus placeholder="写下此刻的想法…" className="font-serif placeholder:font-serif" />
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>{t.common.cancel}</Button>
                          <Button size="sm" variant="primary" onClick={() => saveEdit(h)}><Check size={14} strokeWidth={1.75} />{t.common.save}</Button>
                        </div>
                      </div>
                    ) : (
                      h.noteText && <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-800 dark:text-paper-100">{h.noteText}</p>
                    )}
                    <div className="mt-1 flex justify-end gap-0.5 opacity-0 transition group-hover:opacity-100">
                      <Button size="sm" variant="ghost" title={t.common.edit} onClick={() => { setEditing(h.id); setDraft(h.noteText); }}><Pencil size={14} strokeWidth={1.75} /></Button>
                      <Button size="sm" variant="ghost" title={t.common.delete} className="hover:text-cinnabar-600" onClick={async () => { await deleteHighlight(h.id); await refresh(); }}><Trash2 size={14} strokeWidth={1.75} /></Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
