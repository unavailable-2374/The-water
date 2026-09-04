import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { AlertTriangle, ArrowLeft, ChevronLeft, ChevronRight, Keyboard, List, MessageSquare, PanelRightClose, PanelRightOpen, Search, ScanText, StickyNote, X, ZoomIn, ZoomOut } from 'lucide-react';
import { t } from '@/i18n/zh';
import { Button, Spinner, cn } from '@/components/ui';
import { toast } from '@/components/Toast';
import { getDocument, touchDocument, type DocumentRow } from '@/db/repos/documentsRepo';
import { openDocumentSource } from '@/documents/open';
import { ensureIndexed, useIndexQueue } from '@/documents/indexQueue';
import { EncryptedDocumentError, UnsupportedDocumentError, type DocumentSource, type TextLayerProbe } from '@/documents/types';
import { useReader, SIDEBAR_MAX, SIDEBAR_MIN } from '@/stores/readerStore';
import { DocViewer } from './DocViewer';
import { AiDiscussPanel } from './AiDiscussPanel';
import { NotesPanel } from './NotesPanel';
import { SearchPanel } from './SearchPanel';
import { OutlinePanel } from './OutlinePanel';
import { ShortcutHelp } from './ShortcutHelp';
import { matchShortcut, shouldIgnoreTarget } from './shortcuts';
import { READER_THEMES, THEME_ORDER } from './theme';

export function ReaderPage() {
  const { documentId = '' } = useParams();
  const nav = useNavigate();
  const [doc, setDoc] = useState<DocumentRow | null>(null);
  const [source, setSource] = useState<DocumentSource | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [probe, setProbe] = useState<TextLayerProbe | null>(null);
  const [probeDismissed, setProbeDismissed] = useState(false);
  const {
    scale, setScale, zoomBy, currentPage, numPages, sidePanel, setSidePanel, setDocument, refreshHighlights,
    setNumPages, theme, setTheme, sidebarWidth, setSidebarWidth, sidebarCollapsed, toggleSidebar,
    leftPanel, toggleLeftPanel, loadPreferences, relocateAll, openSearch, stepSearch, setHelpOpen, jumpTo, setSelection,
  } = useReader();
  const cancelIndex = useIndexQueue((s) => s.cancel);
  const clearIndex = useIndexQueue((s) => s.clear);

  useEffect(() => { void loadPreferences(); }, []);

  useEffect(() => {
    let cancelled = false;
    let loaded: DocumentSource | null = null;
    setSource(null);
    setOpenError(null);
    setProbe(null);
    setProbeDismissed(false);
    (async () => {
      const d = await getDocument(documentId);
      if (!d) { toast.error('文档不存在'); nav('/library'); return; }
      setDoc(d);
      setDocument(d.id, d.lastZoom || 1.2, d.lastPage || 1);
      await refreshHighlights();
      // 锚点重定位：文字层变过的高亮会被标出来，不再静默错位
      await relocateAll();
      let s: DocumentSource;
      try {
        s = await openDocumentSource(d);
      } catch (e) {
        if (cancelled) return;
        setOpenError(
          e instanceof EncryptedDocumentError || e instanceof UnsupportedDocumentError
            ? e.message
            : `打不开这个文档：${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }
      if (cancelled) { await s.close(); return; }
      loaded = s;
      setSource(s);
      setNumPages(s.numPages);
      await touchDocument(d.id, {});
      // 建索引改到后台跑，不再挡住阅读
      await ensureIndexed(d);
      s.probeTextLayer().then((p) => { if (!cancelled) setProbe(p); }).catch(() => undefined);
    })().catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
    return () => { cancelled = true; if (loaded) void loaded.close(); };
  }, [documentId]);

  useEffect(() => {
    if (!doc) return;
    const id = setTimeout(() => { void touchDocument(doc.id, { lastPage: currentPage, lastZoom: scale }); }, 500);
    return () => clearTimeout(id);
  }, [currentPage, scale, doc]);

  const go = useCallback((page: number) => {
    const target = Math.max(1, Math.min(numPages || 1, page));
    jumpTo(target);
  }, [numPages, jumpTo]);

  // 快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (shouldIgnoreTarget(el?.tagName, Boolean(el?.isContentEditable), e)) return;
      const action = matchShortcut(e);
      if (!action) return;
      const page = useReader.getState().currentPage;
      switch (action) {
        case 'prevPage': go(page - 1); break;
        case 'nextPage': go(page + 1); break;
        case 'firstPage': go(1); break;
        case 'lastPage': go(numPages || 1); break;
        case 'zoomIn': zoomBy(0.1); break;
        case 'zoomOut': zoomBy(-0.1); break;
        case 'zoomReset': setScale(1); break;
        case 'find': openSearch(); break;
        case 'findNext': stepSearch(1); break;
        case 'findPrev': stepSearch(-1); break;
        case 'toggleOutline': toggleLeftPanel('outline'); break;
        case 'toggleSidebar': toggleSidebar(); break;
        case 'help': setHelpOpen(!useReader.getState().helpOpen); break;
        case 'escape':
          if (useReader.getState().helpOpen) setHelpOpen(false);
          else setSelection(null);
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, numPages, zoomBy, setScale, openSearch, stepSearch, toggleLeftPanel, toggleSidebar, setHelpOpen, setSelection]);

  const panelBtn = (key: typeof sidePanel, Icon: typeof MessageSquare, label: string) => (
    <button
      onClick={() => setSidePanel(key)}
      title={label}
      className={cn(
        'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition',
        sidePanel === key && !sidebarCollapsed
          ? 'bg-paper-0 font-medium text-tea-700 shadow-soft dark:bg-paper-800 dark:text-tea-200'
          : 'text-ink-500 hover:text-ink-800 dark:text-ink-300 dark:hover:text-paper-100',
      )}
    >
      <Icon size={14} strokeWidth={1.75} />
      {label}
    </button>
  );

  const showScanNotice = probe && !probe.hasText && !probeDismissed && source?.renderMode === 'canvas';

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-paper-300/60 bg-paper-50/85 px-4 backdrop-blur dark:border-paper-800 dark:bg-paper-900/85">
        <Button size="sm" variant="ghost" onClick={() => nav('/library')}><ArrowLeft size={16} strokeWidth={1.75} />书架</Button>
        <Button size="sm" variant="ghost" title="目录 / 缩略图 (⌘B)" className={cn(leftPanel !== 'none' && 'text-tea-700 dark:text-tea-200')} onClick={() => toggleLeftPanel(leftPanel === 'none' ? 'outline' : leftPanel)}>
          <List size={16} strokeWidth={1.75} />
        </Button>
        <span className="min-w-0 flex-1 truncate font-serif text-sm font-medium tracking-wide text-ink-800 dark:text-paper-100">{doc?.title ?? t.common.loading}</span>
        <IndexingChip documentId={documentId} onCancel={() => cancelIndex(documentId)} onDismiss={() => clearIndex(documentId)} />
        <PageJump current={currentPage} total={numPages} onGo={go} />
        <div className="flex items-center gap-0.5">
          <Button size="sm" variant="ghost" title="缩小 (⌘-)" onClick={() => zoomBy(-0.1)}><ZoomOut size={16} strokeWidth={1.75} /></Button>
          <button className="w-11 text-center font-serif text-xs tabular-nums text-ink-500 hover:text-ink-800" title="恢复 100% (⌘0)" onClick={() => setScale(1)}>{Math.round(scale * 100)}%</button>
          <Button size="sm" variant="ghost" title="放大 (⌘+)" onClick={() => zoomBy(0.1)}><ZoomIn size={16} strokeWidth={1.75} /></Button>
        </div>
        <div className="flex gap-0.5 rounded-full bg-paper-200/70 p-0.5 dark:bg-paper-800/70">
          {THEME_ORDER.map((k) => (
            <button
              key={k}
              onClick={() => setTheme(k)}
              title={`${READER_THEMES[k].label}读模式`}
              className={cn(
                'rounded-full px-2.5 py-1 font-serif text-xs transition',
                theme === k ? 'bg-paper-0 font-medium text-tea-700 shadow-soft dark:bg-paper-800 dark:text-tea-200' : 'text-ink-500 hover:text-ink-800 dark:text-ink-300',
              )}
            >
              {READER_THEMES[k].label}
            </button>
          ))}
        </div>
        <div className="ml-1 flex gap-0.5 rounded-full bg-paper-200/70 p-0.5 dark:bg-paper-800/70">
          {panelBtn('ai', MessageSquare, 'AI 讨论')}
          {panelBtn('notes', StickyNote, '我的笔记')}
          {panelBtn('search', Search, '查找')}
        </div>
        <Button size="sm" variant="ghost" title="快捷键 (?)" onClick={() => setHelpOpen(true)}><Keyboard size={16} strokeWidth={1.75} /></Button>
        <Button size="sm" variant="ghost" title={sidebarCollapsed ? '展开侧栏 (⌘\\)' : '收起侧栏 (⌘\\)'} onClick={toggleSidebar}>
          {sidebarCollapsed ? <PanelRightOpen size={16} strokeWidth={1.75} /> : <PanelRightClose size={16} strokeWidth={1.75} />}
        </Button>
      </header>

      {showScanNotice && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-300/50 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <ScanText size={14} strokeWidth={1.75} className="shrink-0" />
          <span className="flex-1">这本书没有文字层（多半是扫描件），只能看图：搜索、划线和 AI 讨论都用不了。文字识别（OCR）还在计划里。</span>
          <button className="rounded p-1 hover:bg-amber-100 dark:hover:bg-amber-500/20" onClick={() => setProbeDismissed(true)} title="知道了"><X size={13} strokeWidth={1.75} /></button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {leftPanel !== 'none' && source && (
          <aside className="w-[172px] shrink-0 overflow-hidden border-r border-paper-300/60 bg-paper-50 dark:border-paper-800 dark:bg-paper-900">
            <OutlinePanel source={source} />
          </aside>
        )}
        <div className="min-w-0 flex-1 bg-paper-200/60 paper-texture dark:bg-paper-950">
          {openError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-10 text-center text-ink-500">
              <AlertTriangle size={32} strokeWidth={1.25} className="text-amber-500" />
              <p className="max-w-md font-serif text-sm leading-relaxed">{openError}</p>
              <Button size="sm" onClick={() => nav('/library')}>回到书架</Button>
            </div>
          ) : source ? (
            <DocViewer source={source} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-ink-400">
              <Spinner />
              <span className="font-serif text-sm">正在翻开这本书…</span>
            </div>
          )}
        </div>
        {!sidebarCollapsed && (
          <>
            <SidebarHandle width={sidebarWidth} onResize={setSidebarWidth} />
            <aside className="flex shrink-0 flex-col border-l border-paper-300/60 bg-paper-50 dark:border-paper-800 dark:bg-paper-900" style={{ width: sidebarWidth }}>
              {doc && sidePanel === 'ai' && <AiDiscussPanel doc={doc} />}
              {doc && sidePanel === 'notes' && <NotesPanel doc={doc} />}
              {doc && sidePanel === 'search' && <SearchPanel doc={doc} />}
            </aside>
          </>
        )}
      </div>
      <ShortcutHelp />
    </div>
  );
}

/** 侧栏拖宽把手：拖动时只改界面，松手才落盘。 */
function SidebarHandle({ width, onResize }: { width: number; onResize: (w: number, persist?: boolean) => void }) {
  const dragging = useRef(false);
  useEffect(() => {
    const onMove = (e: MouseEvent) => { if (dragging.current) onResize(window.innerWidth - e.clientX, false); };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      onResize(width, true);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [onResize, width]);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title={`拖动调整宽度（${SIDEBAR_MIN}–${SIDEBAR_MAX}）`}
      onMouseDown={() => { dragging.current = true; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; }}
      onDoubleClick={() => onResize(380, true)}
      className="w-1 shrink-0 cursor-col-resize bg-transparent transition hover:bg-tea-500/40"
    />
  );
}

/** 页码跳转框。 */
function PageJump({ current, total, onGo }: { current: number; total: number; onGo: (n: number) => void }) {
  const [draft, setDraft] = useState('');
  const value = draft !== '' ? draft : String(current);
  return (
    <div className="flex items-center gap-0.5">
      <Button size="sm" variant="ghost" title="上一页 (←)" disabled={current <= 1} onClick={() => onGo(current - 1)}><ChevronLeft size={16} strokeWidth={1.75} /></Button>
      <input
        value={value}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
        onFocus={(e) => { setDraft(String(current)); e.currentTarget.select(); }}
        onBlur={() => setDraft('')}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const n = Number(draft || value);
            if (n >= 1) onGo(n);
            e.currentTarget.blur();
          }
          if (e.key === 'Escape') { setDraft(''); e.currentTarget.blur(); }
        }}
        title="输入页码后回车跳转"
        className="w-11 rounded-lg border border-paper-300/70 bg-paper-0 px-1 py-0.5 text-center font-serif text-xs tabular-nums text-ink-700 outline-none focus:border-tea-500 dark:border-paper-700 dark:bg-paper-800 dark:text-ink-200"
      />
      <span className="font-serif text-xs tabular-nums text-ink-400">/ {total}</span>
      <Button size="sm" variant="ghost" title="下一页 (→)" disabled={total > 0 && current >= total} onClick={() => onGo(current + 1)}><ChevronRight size={16} strokeWidth={1.75} /></Button>
    </div>
  );
}

/** 后台建索引的进度条：可见、可取消。 */
function IndexingChip({ documentId, onCancel, onDismiss }: { documentId: string; onCancel: () => void; onDismiss: () => void }) {
  const task = useIndexQueue((s) => s.tasks[documentId]);
  useEffect(() => {
    if (task?.status !== 'done') return;
    const id = setTimeout(onDismiss, 2500);
    return () => clearTimeout(id);
  }, [task?.status, onDismiss]);
  if (!task || task.status === 'done') return null;
  if (task.status === 'running') {
    return (
      <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-ink-400">
        <Spinner className="h-3 w-3" />
        {t.reader.indexing} {task.done}/{task.total || '…'}
        <button className="rounded px-1 text-ink-400 underline-offset-2 hover:text-ink-700 hover:underline" onClick={onCancel}>取消</button>
      </span>
    );
  }
  if (task.status === 'cancelled') {
    return (
      <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-ink-400">
        文本提取已取消
        <button className="rounded px-1 underline-offset-2 hover:text-ink-700 hover:underline" onClick={onDismiss}>知道了</button>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-cinnabar-600" title={task.error}>
      文本提取失败
      <button className="rounded px-1 underline-offset-2 hover:underline" onClick={onDismiss}>知道了</button>
    </span>
  );
}
