import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Copy, Highlighter, MessageSquare, StickyNote } from 'lucide-react';
import { t } from '@/i18n';
import { Button, Textarea, cn } from '@/components/ui';
import { toast } from '@/components/Toast';
import { getPageText } from '@/db/repos/documentsRepo';
import { buildAnchor } from '@/pdf/anchor';
import { useReader } from '@/stores/readerStore';
import { DEFAULT_HIGHLIGHT_COLOR, HIGHLIGHT_COLORS } from './colors';
import { clampPopover } from './popover';

const WIDTH = 300;

export function SelectionPopover() {
  const sel = useReader((s) => s.selection);
  const documentId = useReader((s) => s.documentId);
  const setSelection = useReader((s) => s.setSelection);
  const addHighlight = useReader((s) => s.addHighlight);
  const ask = useReader((s) => s.ask);
  const [noteMode, setNoteMode] = useState(false);
  const [note, setNote] = useState('');
  const [color, setColor] = useState(DEFAULT_HIGHLIGHT_COLOR);
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => { setNoteMode(false); setNote(''); }, [sel]);

  // 点击气泡以外的地方就收起；Esc 同理
  useEffect(() => {
    if (!sel) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest('[data-popover]')) setSelection(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelection(null); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [sel, setSelection]);

  // 量出真实高度后再定位：下方放不下就翻到选区上面，始终留出边距
  useLayoutEffect(() => {
    if (!sel) { setPos(null); return; }
    const h = boxRef.current?.offsetHeight ?? 120;
    setPos(clampPopover({
      anchorX: sel.clientX,
      below: sel.clientY,
      above: sel.clientTop,
      width: WIDTH,
      height: h,
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
    }));
  }, [sel, noteMode, note]);

  if (!sel || !documentId) return null;

  const save = async (kind: 'highlight' | 'note') => {
    const pageText = (await getPageText(documentId, sel.pageNo)) ?? '';
    const anchor = sel.start >= 0 && pageText
      ? buildAnchor(pageText, sel.start, sel.end, sel.rects)
      : { exact: sel.text, prefix: '', suffix: '', start: null, end: null, rects: sel.rects };
    await addHighlight({ pageNo: sel.pageNo, kind, color, anchor, noteText: kind === 'note' ? note : '' });
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    toast.success(kind === 'note' ? t.reader.noteSaved : t.reader.highlighted);
  };

  return (
    <div
      ref={boxRef}
      data-popover
      className="fixed z-40 w-[300px] rounded-2xl bg-paper-0 p-2 shadow-lift dark:bg-paper-900"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {!noteMode ? (
        <div className="space-y-1.5">
          <div role="toolbar" aria-label={t.reader.selectionActions} className="flex flex-wrap items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => save('highlight')}><Highlighter size={14} strokeWidth={1.75} aria-hidden="true" />{t.reader.highlight}</Button>
            <Button size="sm" variant="ghost" onClick={() => setNoteMode(true)}><StickyNote size={14} strokeWidth={1.75} aria-hidden="true" />{t.reader.addNote}</Button>
            <Button size="sm" variant="ai" onClick={() => ask(sel.text, sel.pageNo)}><MessageSquare size={14} strokeWidth={1.75} aria-hidden="true" />{t.reader.discussPassage}</Button>
            <Button size="sm" variant="ghost" title={t.common.copy} aria-label={t.common.copy} onClick={() => { void navigator.clipboard.writeText(sel.text); toast.info(t.common.copied); setSelection(null); }}><Copy size={14} strokeWidth={1.75} aria-hidden="true" /></Button>
          </div>
          <ColorPicker value={color} onChange={setColor} />
        </div>
      ) : (
        <div role="group" aria-label={t.reader.addNote} className="space-y-2.5 p-1">
          <p className="line-clamp-2 border-l-2 border-tea-500/60 pl-2.5 font-serif text-xs leading-relaxed text-ink-500 dark:text-ink-300">{sel.text}</p>
          <Textarea rows={3} autoFocus value={note} onChange={(e) => setNote(e.target.value)} aria-label={t.reader.addNote} placeholder={t.reader.notePlaceholder} className="font-serif placeholder:font-serif" />
          <ColorPicker value={color} onChange={setColor} />
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" onClick={() => setNoteMode(false)}>{t.common.cancel}</Button>
            <Button size="sm" onClick={() => save('note')}>{t.common.save}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div role="group" aria-label={t.reader.colorGroup} className="flex items-center gap-1.5 px-1.5 pb-0.5">
      <span aria-hidden="true" className="font-serif text-[11px] text-ink-400">{t.reader.colorGroup}</span>
      {HIGHLIGHT_COLORS.map((c) => (
        <button
          key={c.key}
          title={c.label}
          aria-label={c.label}
          aria-pressed={value === c.key}
          onClick={() => onChange(c.key)}
          className={cn(
            'h-4 w-4 rounded-full border transition focus:outline-none focus-visible:ring-2 focus-visible:ring-tea-500/50',
            value === c.key ? 'border-ink-600 ring-2 ring-ink-500/25 dark:border-paper-200' : 'border-black/10 hover:scale-110',
          )}
          style={{ background: c.css }}
        />
      ))}
    </div>
  );
}
