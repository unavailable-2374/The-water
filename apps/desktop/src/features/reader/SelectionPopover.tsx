import { useEffect, useState } from 'react';
import { Copy, Highlighter, MessageSquare, StickyNote } from 'lucide-react';
import { t } from '@/i18n/zh';
import { Button, Textarea } from '@/components/ui';
import { toast } from '@/components/Toast';
import { createHighlight } from '@/db/repos/highlightsRepo';
import { getPageText } from '@/db/repos/documentsRepo';
import { buildAnchor } from '@/pdf/anchor';
import { useReader } from '@/stores/readerStore';

export function SelectionPopover() {
  const sel = useReader((s) => s.selection);
  const documentId = useReader((s) => s.documentId);
  const setSelection = useReader((s) => s.setSelection);
  const refresh = useReader((s) => s.refreshHighlights);
  const ask = useReader((s) => s.ask);
  const [noteMode, setNoteMode] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => { setNoteMode(false); setNote(''); }, [sel]);
  useEffect(() => {
    if (!sel) return;
    const onDown = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('[data-popover]')) { /* keep until next selection */ } };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [sel]);

  if (!sel || !documentId) return null;

  const save = async (kind: 'highlight' | 'note') => {
    const pageText = (await getPageText(documentId, sel.pageNo)) ?? '';
    const anchor = sel.start >= 0 && pageText
      ? buildAnchor(pageText, sel.start, sel.end, sel.rects)
      : { exact: sel.text, prefix: '', suffix: '', start: null, end: null, rects: sel.rects };
    await createHighlight({ documentId, pageNo: sel.pageNo, kind, anchor, noteText: kind === 'note' ? note : '' });
    await refresh();
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    toast.success(kind === 'note' ? '笔记已保存' : '已高亮');
  };

  const x = Math.min(sel.clientX, window.innerWidth - 320);
  const y = sel.clientY + 8;

  return (
    <div data-popover className="fixed z-40 w-[300px] rounded-2xl bg-paper-0 p-2 shadow-lift dark:bg-paper-900" style={{ left: x - 150, top: y }} onMouseDown={(e) => e.stopPropagation()}>
      {!noteMode ? (
        <div className="flex flex-wrap items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => save('highlight')}><Highlighter size={14} strokeWidth={1.75} />{t.reader.highlight}</Button>
          <Button size="sm" variant="ghost" onClick={() => setNoteMode(true)}><StickyNote size={14} strokeWidth={1.75} />记笔记</Button>
          <Button size="sm" variant="ai" onClick={() => ask(sel.text, sel.pageNo)}><MessageSquare size={14} strokeWidth={1.75} />和 AI 聊聊这段</Button>
          <Button size="sm" variant="ghost" title="复制" onClick={() => { void navigator.clipboard.writeText(sel.text); toast.info(t.common.copied); setSelection(null); }}><Copy size={14} strokeWidth={1.75} /></Button>
        </div>
      ) : (
        <div className="space-y-2.5 p-1">
          <p className="line-clamp-2 border-l-2 border-tea-500/60 pl-2.5 font-serif text-xs leading-relaxed text-ink-500 dark:text-ink-300">{sel.text}</p>
          <Textarea rows={3} autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="写下此刻的想法…" className="font-serif placeholder:font-serif" />
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" onClick={() => setNoteMode(false)}>{t.common.cancel}</Button>
            <Button size="sm" onClick={() => save('note')}>{t.common.save}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
