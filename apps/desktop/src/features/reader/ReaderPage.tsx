import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { ArrowLeft, MessageSquare, StickyNote, Search, ZoomIn, ZoomOut } from 'lucide-react';
import { t } from '@/i18n/zh';
import { Button, Spinner, cn } from '@/components/ui';
import { toast } from '@/components/Toast';
import { getDocument, touchDocument, type DocumentRow } from '@/db/repos/documentsRepo';
import { closePdf, openPdf } from '@/pdf/pdfjs';
import { absolutePathFor } from '@/pdf/import';
import { indexDocumentText } from '@/pdf/textIndex';
import { useReader } from '@/stores/readerStore';
import { PdfViewer } from './PdfViewer';
import { AiDiscussPanel } from './AiDiscussPanel';
import { NotesPanel } from './NotesPanel';
import { SearchPanel } from './SearchPanel';

export function ReaderPage() {
  const { documentId = '' } = useParams();
  const nav = useNavigate();
  const [doc, setDoc] = useState<DocumentRow | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [indexing, setIndexing] = useState<string | null>(null);
  const { scale, setScale, currentPage, numPages, sidePanel, setSidePanel, setDocument, refreshHighlights, setNumPages } = useReader();

  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    (async () => {
      const d = await getDocument(documentId);
      if (!d) { toast.error('文档不存在'); nav('/library'); return; }
      setDoc(d);
      setDocument(d.id, d.lastZoom || 1.2, d.lastPage || 1);
      await refreshHighlights();
      const p = await openPdf(await absolutePathFor(d.fileRelPath));
      if (cancelled) { await closePdf(p); return; }
      loaded = p;
      setPdf(p);
      setNumPages(p.numPages);
      await touchDocument(d.id, {});
      if (!d.textIndexed) {
        setIndexing(t.reader.indexing);
        await indexDocumentText(p, d.id, (done, total) => setIndexing(`${t.reader.indexing} ${done}/${total}`)).catch((e) => toast.error(String(e)));
        setIndexing(null);
      }
    })().catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
    return () => { cancelled = true; if (loaded) void closePdf(loaded); };
  }, [documentId]);

  useEffect(() => {
    if (!doc) return;
    const id = setTimeout(() => { void touchDocument(doc.id, { lastPage: currentPage, lastZoom: scale }); }, 500);
    return () => clearTimeout(id);
  }, [currentPage, scale, doc]);

  const panelBtn = (key: typeof sidePanel, Icon: typeof MessageSquare, label: string) => (
    <button
      onClick={() => setSidePanel(key)}
      title={label}
      className={cn(
        'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition',
        sidePanel === key
          ? 'bg-paper-0 font-medium text-tea-700 shadow-soft dark:bg-paper-800 dark:text-tea-200'
          : 'text-ink-500 hover:text-ink-800 dark:text-ink-300 dark:hover:text-paper-100',
      )}
    >
      <Icon size={14} strokeWidth={1.75} />
      {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-paper-300/60 bg-paper-50/85 px-4 backdrop-blur dark:border-paper-800 dark:bg-paper-900/85">
        <Button size="sm" variant="ghost" onClick={() => nav('/library')}><ArrowLeft size={16} strokeWidth={1.75} />书架</Button>
        <span className="min-w-0 flex-1 truncate font-serif text-sm font-medium tracking-wide text-ink-800 dark:text-paper-100">{doc?.title ?? t.common.loading}</span>
        {indexing && <span className="flex items-center gap-1.5 text-xs text-ink-400"><Spinner className="h-3 w-3" />{indexing}</span>}
        <span className="font-serif text-xs tabular-nums text-ink-500">{currentPage} / {numPages}</span>
        <div className="flex items-center gap-0.5">
          <Button size="sm" variant="ghost" title="缩小" onClick={() => setScale(Math.max(0.5, +(scale - 0.1).toFixed(2)))}><ZoomOut size={16} strokeWidth={1.75} /></Button>
          <span className="w-11 text-center font-serif text-xs tabular-nums text-ink-500">{Math.round(scale * 100)}%</span>
          <Button size="sm" variant="ghost" title="放大" onClick={() => setScale(Math.min(3, +(scale + 0.1).toFixed(2)))}><ZoomIn size={16} strokeWidth={1.75} /></Button>
        </div>
        <div className="ml-1 flex gap-0.5 rounded-full bg-paper-200/70 p-0.5 dark:bg-paper-800/70">
          {panelBtn('ai', MessageSquare, 'AI 讨论')}
          {panelBtn('notes', StickyNote, '我的笔记')}
          {panelBtn('search', Search, '查找')}
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 bg-paper-200/60 paper-texture dark:bg-paper-950">
          {pdf ? <PdfViewer pdf={pdf} /> : (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-ink-400">
              <Spinner />
              <span className="font-serif text-sm">正在翻开这本书…</span>
            </div>
          )}
        </div>
        <aside className="flex w-[380px] shrink-0 flex-col border-l border-paper-300/60 bg-paper-50 dark:border-paper-800 dark:bg-paper-900">
          {doc && sidePanel === 'ai' && <AiDiscussPanel doc={doc} />}
          {doc && sidePanel === 'notes' && <NotesPanel doc={doc} />}
          {doc && sidePanel === 'search' && <SearchPanel doc={doc} />}
        </aside>
      </div>
    </div>
  );
}
