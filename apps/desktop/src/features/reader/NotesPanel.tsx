import { useState } from 'react';
import { Trash2, Pencil, Check, Download, AlertTriangle } from 'lucide-react';
import { fmt, t } from '@/i18n';
import { Button, EmptyState, HoverAction, Textarea, deleteLabel } from '@/components/ui';
import { toast } from '@/components/Toast';
import type { DocumentRow } from '@/db/repos/documentsRepo';
import type { Highlight } from '@/db/repos/highlightsRepo';
import { countMissing } from '@/documents/relocate';
import { useReader } from '@/stores/readerStore';
import { ColorPicker } from './SelectionPopover';
import { exportHighlights } from './exportMarkdown';

export function NotesPanel({ doc }: { doc: DocumentRow }) {
  const highlights = useReader((s) => s.highlights);
  const locations = useReader((s) => s.locations);
  const editHighlight = useReader((s) => s.editHighlight);
  const dropHighlight = useReader((s) => s.dropHighlight);
  const jumpTo = useReader((s) => s.jumpTo);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const byPage = new Map<number, Highlight[]>();
  for (const h of highlights) byPage.set(h.pageNo, [...(byPage.get(h.pageNo) ?? []), h]);
  const missing = countMissing(locations);

  const saveEdit = async (h: Highlight) => {
    await editHighlight(h.id, { noteText: draft, kind: draft ? 'note' : h.kind });
    setEditing(null);
  };

  // 导出是一次命令式写盘（还要弹系统保存框），不是可重放的取数，因此仍留在组件里
  const doExport = async () => {
    setBusy(true);
    try {
      const path = await exportHighlights({ title: doc.title, author: doc.author, pageCount: doc.pageCount }, highlights);
      if (path) toast.success(fmt(t.reader.exportedTo, { path }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-baseline gap-2 px-5 pb-2 pt-4">
        <h2 className="font-serif text-sm font-semibold tracking-wide text-ink-800 dark:text-paper-100">{t.reader.myNotes}</h2>
        <span className="font-serif text-xs text-ink-400">{fmt(t.reader.noteCount, { n: highlights.length })}</span>
        {missing > 0 && (
          <span className="flex items-center gap-1 font-serif text-xs text-amber-600 dark:text-amber-400" title={t.reader.missingTip}>
            <AlertTriangle size={12} strokeWidth={1.75} aria-hidden="true" />{fmt(t.reader.missingCount, { n: missing })}
          </span>
        )}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" title={t.reader.exportTip} disabled={busy || highlights.length === 0} onClick={doExport}>
          <Download size={14} strokeWidth={1.75} aria-hidden="true" />{t.reader.exportAction}
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-4 scrollbar-thin">
        {highlights.length === 0 ? (
          <EmptyState title={t.reader.emptyNotes} description={t.reader.noNotes} />
        ) : (
          [...byPage.entries()].sort((a, b) => a[0] - b[0]).map(([page, list]) => (
            <div key={page} className="mb-5">
              <div className="mb-2 px-1 font-serif text-[11px] tracking-widest text-ink-400">{fmt(t.reader.page, { n: page })}</div>
              <ul className="space-y-2">
                {list.map((h) => {
                  const lost = locations[h.id]?.status === 'missing';
                  return (
                    <li key={h.id} className="group rounded-2xl bg-paper-0 p-3.5 shadow-soft transition hover:shadow-lift dark:bg-paper-800">
                      <button
                        className="block w-full rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-tea-500/50"
                        aria-label={fmt(t.reader.jumpToNote, { n: h.pageNo })}
                        onClick={() => jumpTo(h.pageNo, h.id)}
                      >
                        <p className="line-clamp-3 border-l-2 border-tea-500/60 pl-3 font-serif text-[13px] leading-relaxed text-ink-600 dark:text-ink-300">{h.anchor.exact}</p>
                      </button>
                      {lost && (
                        <p className="mt-2 flex items-center gap-1 font-serif text-[11px] text-amber-600 dark:text-amber-400">
                          <AlertTriangle size={11} strokeWidth={1.75} aria-hidden="true" />
                          {t.reader.missingDetail}
                        </p>
                      )}
                      {editing === h.id ? (
                        <div className="mt-2.5 space-y-1.5">
                          <Textarea rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus aria-label={t.reader.notes} placeholder={t.reader.notePlaceholder} className="font-serif placeholder:font-serif" />
                          <ColorPicker value={h.color} onChange={(color) => void editHighlight(h.id, { color })} />
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>{t.common.cancel}</Button>
                            <Button size="sm" variant="primary" onClick={() => saveEdit(h)}><Check size={14} strokeWidth={1.75} aria-hidden="true" />{t.common.save}</Button>
                          </div>
                        </div>
                      ) : (
                        h.noteText && <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-800 dark:text-paper-100">{h.noteText}</p>
                      )}
                      {/* 悬停才显示的操作：用 HoverAction，键盘 Tab 到它一样会显形 */}
                      <div className="mt-1 flex justify-end gap-0.5">
                        <HoverAction label={t.common.edit} onClick={() => { setEditing(h.id); setDraft(h.noteText); }}>
                          <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
                        </HoverAction>
                        <HoverAction label={deleteLabel(h.anchor.exact.slice(0, 12))} className="hover:text-cinnabar-600" onClick={() => void dropHighlight(h.id)}>
                          <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
                        </HoverAction>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
