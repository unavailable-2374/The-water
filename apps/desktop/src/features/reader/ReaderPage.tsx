import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { AlertTriangle, ArrowLeft, ChevronLeft, ChevronRight, Keyboard, List, MessageSquare, PanelRightClose, PanelRightOpen, Search, ScanText, StickyNote, X, ZoomIn, ZoomOut } from 'lucide-react';
import { fmt, t } from '@/i18n';
import { Button, IconButton, Spinner, cn } from '@/components/ui';
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

/** 侧栏面板与它的按钮共用一组 id，好把 tab 和 tabpanel 关联起来。 */
const PANEL_ID = 'reader-side-panel';
const tabId = (key: string) => `reader-tab-${key}`;

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
      if (!d) { toast.error(t.reader.docNotFound); nav('/library'); return; }
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
            : fmt(t.reader.openFailed, { message: e instanceof Error ? e.message : String(e) }),
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

  const panelBtn = (key: typeof sidePanel, Icon: typeof MessageSquare, label: string) => {
    const selected = sidePanel === key && !sidebarCollapsed;
    return (
      <button
        role="tab"
        id={tabId(key)}
        aria-selected={selected}
        aria-controls={PANEL_ID}
        onClick={() => setSidePanel(key)}
        title={label}
        className={cn(
          'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-tea-500/50',
          selected
            ? 'bg-paper-0 font-medium text-tea-700 shadow-soft dark:bg-paper-800 dark:text-tea-200'
            : 'text-ink-500 hover:text-ink-800 dark:text-ink-300 dark:hover:text-paper-100',
        )}
      >
        <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
        {label}
      </button>
    );
  };

  const showScanNotice = probe && !probe.hasText && !probeDismissed && source?.renderMode === 'canvas';

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-paper-300/60 bg-paper-50/85 px-4 backdrop-blur dark:border-paper-800 dark:bg-paper-900/85">
        <Button size="sm" variant="ghost" onClick={() => nav('/library')}><ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />{t.reader.library}</Button>
        <Button
          size="sm"
          variant="ghost"
          title={t.reader.outlineToggle}
          aria-label={t.reader.outlineToggle}
          aria-pressed={leftPanel !== 'none'}
          className={cn(leftPanel !== 'none' && 'text-tea-700 dark:text-tea-200')}
          onClick={() => toggleLeftPanel(leftPanel === 'none' ? 'outline' : leftPanel)}
        >
          <List size={16} strokeWidth={1.75} aria-hidden="true" />
        </Button>
        <span className="min-w-0 flex-1 truncate font-serif text-sm font-medium tracking-wide text-ink-800 dark:text-paper-100">{doc?.title ?? t.common.loading}</span>
        <IndexingChip documentId={documentId} onCancel={() => cancelIndex(documentId)} onDismiss={() => clearIndex(documentId)} />
        <PageJump current={currentPage} total={numPages} onGo={go} />
        <div className="flex items-center gap-0.5">
          <Button size="sm" variant="ghost" title={t.reader.zoomOut} aria-label={t.reader.zoomOut} onClick={() => zoomBy(-0.1)}><ZoomOut size={16} strokeWidth={1.75} aria-hidden="true" /></Button>
          <button
            className="w-11 rounded text-center font-serif text-xs tabular-nums text-ink-500 hover:text-ink-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-tea-500/50"
            title={t.reader.zoomReset}
            aria-label={t.reader.zoomReset}
            onClick={() => setScale(1)}
          >
            {Math.round(scale * 100)}%
          </button>
          <Button size="sm" variant="ghost" title={t.reader.zoomIn} aria-label={t.reader.zoomIn} onClick={() => zoomBy(0.1)}><ZoomIn size={16} strokeWidth={1.75} aria-hidden="true" /></Button>
        </div>
        <div role="group" aria-label={t.reader.themeGroup} className="flex gap-0.5 rounded-full bg-paper-200/70 p-0.5 dark:bg-paper-800/70">
          {THEME_ORDER.map((k) => (
            <button
              key={k}
              onClick={() => setTheme(k)}
              title={fmt(t.reader.themeMode, { label: READER_THEMES[k].label })}
              aria-pressed={theme === k}
              className={cn(
                'rounded-full px-2.5 py-1 font-serif text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-tea-500/50',
                theme === k ? 'bg-paper-0 font-medium text-tea-700 shadow-soft dark:bg-paper-800 dark:text-tea-200' : 'text-ink-500 hover:text-ink-800 dark:text-ink-300',
              )}
            >
              {READER_THEMES[k].label}
            </button>
          ))}
        </div>
        <div role="tablist" aria-label={t.reader.panelGroup} className="ml-1 flex gap-0.5 rounded-full bg-paper-200/70 p-0.5 dark:bg-paper-800/70">
          {panelBtn('ai', MessageSquare, t.reader.ai)}
          {panelBtn('notes', StickyNote, t.reader.myNotes)}
          {panelBtn('search', Search, t.reader.find)}
        </div>
        <Button size="sm" variant="ghost" title={t.reader.shortcutsTip} aria-label={t.reader.shortcutsTip} onClick={() => setHelpOpen(true)}><Keyboard size={16} strokeWidth={1.75} aria-hidden="true" /></Button>
        <Button
          size="sm"
          variant="ghost"
          title={sidebarCollapsed ? t.reader.expandSidebar : t.reader.collapseSidebar}
          aria-label={sidebarCollapsed ? t.reader.expandSidebar : t.reader.collapseSidebar}
          aria-expanded={!sidebarCollapsed}
          onClick={toggleSidebar}
        >
          {sidebarCollapsed ? <PanelRightOpen size={16} strokeWidth={1.75} aria-hidden="true" /> : <PanelRightClose size={16} strokeWidth={1.75} aria-hidden="true" />}
        </Button>
      </header>

      {showScanNotice && (
        <div role="status" aria-live="polite" className="flex shrink-0 items-center gap-2 border-b border-amber-300/50 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <ScanText size={14} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
          <span className="flex-1">{t.reader.scanNotice}</span>
          <IconButton label={t.reader.gotIt} className="hover:bg-amber-100 dark:hover:bg-amber-500/20" onClick={() => setProbeDismissed(true)}>
            <X size={13} strokeWidth={1.75} aria-hidden="true" />
          </IconButton>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {leftPanel !== 'none' && source && (
          <aside className="w-[172px] shrink-0 overflow-hidden border-r border-paper-300/60 bg-paper-50 dark:border-paper-800 dark:bg-paper-900">
            <OutlinePanel source={source} />
          </aside>
        )}
        <div role="document" aria-label={doc?.title ?? t.reader.content} className="min-w-0 flex-1 bg-paper-200/60 paper-texture dark:bg-paper-950">
          {openError ? (
            <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 px-10 text-center text-ink-500">
              <AlertTriangle size={32} strokeWidth={1.25} className="text-amber-500" aria-hidden="true" />
              <p className="max-w-md font-serif text-sm leading-relaxed">{openError}</p>
              <Button size="sm" onClick={() => nav('/library')}>{t.reader.backToLibrary}</Button>
            </div>
          ) : source ? (
            <DocViewer source={source} />
          ) : (
            <div role="status" aria-live="polite" className="flex h-full flex-col items-center justify-center gap-3 text-ink-400">
              <Spinner />
              <span className="font-serif text-sm">{t.reader.opening}</span>
            </div>
          )}
        </div>
        {!sidebarCollapsed && (
          <>
            <SidebarHandle width={sidebarWidth} onResize={setSidebarWidth} />
            <aside
              id={PANEL_ID}
              role="tabpanel"
              aria-labelledby={tabId(sidePanel)}
              className="flex shrink-0 flex-col border-l border-paper-300/60 bg-paper-50 dark:border-paper-800 dark:bg-paper-900"
              style={{ width: sidebarWidth }}
            >
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

/** 一次方向键调多少宽度。 */
const STEP = 24;

/** 侧栏拖宽把手：拖动时只改界面，松手才落盘；键盘用左右方向键。 */
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
  const label = fmt(t.reader.resizeSidebar, { min: SIDEBAR_MIN, max: SIDEBAR_MAX });
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      tabIndex={0}
      title={label}
      onMouseDown={() => { dragging.current = true; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; }}
      onDoubleClick={() => onResize(380, true)}
      onKeyDown={(e) => {
        // 侧栏在右边：← 拉宽，→ 收窄
        if (e.key === 'ArrowLeft') { e.preventDefault(); onResize(width + STEP, true); }
        if (e.key === 'ArrowRight') { e.preventDefault(); onResize(width - STEP, true); }
        if (e.key === 'Home') { e.preventDefault(); onResize(SIDEBAR_MIN, true); }
        if (e.key === 'End') { e.preventDefault(); onResize(SIDEBAR_MAX, true); }
      }}
      className="w-1 shrink-0 cursor-col-resize bg-transparent transition hover:bg-tea-500/40 focus:outline-none focus-visible:bg-tea-500/60"
    />
  );
}

/** 页码跳转框。 */
function PageJump({ current, total, onGo }: { current: number; total: number; onGo: (n: number) => void }) {
  const [draft, setDraft] = useState('');
  const value = draft !== '' ? draft : String(current);
  return (
    <div className="flex items-center gap-0.5">
      <Button size="sm" variant="ghost" title={t.reader.prevPage} aria-label={t.reader.prevPage} disabled={current <= 1} onClick={() => onGo(current - 1)}><ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" /></Button>
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
        title={t.reader.pageInputTip}
        aria-label={t.reader.pageInput}
        className="w-11 rounded-lg border border-paper-300/70 bg-paper-0 px-1 py-0.5 text-center font-serif text-xs tabular-nums text-ink-700 outline-none focus:border-tea-500 dark:border-paper-700 dark:bg-paper-800 dark:text-ink-200"
      />
      <span className="font-serif text-xs tabular-nums text-ink-400">/ {total}</span>
      <Button size="sm" variant="ghost" title={t.reader.nextPage} aria-label={t.reader.nextPage} disabled={total > 0 && current >= total} onClick={() => onGo(current + 1)}><ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" /></Button>
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
      <span role="status" aria-live="polite" className="flex items-center gap-1.5 whitespace-nowrap text-xs text-ink-400">
        <Spinner className="h-3 w-3" />
        {t.reader.indexing} {task.done}/{task.total || '…'}
        <button className="rounded px-1 text-ink-400 underline-offset-2 hover:text-ink-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-tea-500/50" onClick={onCancel}>{t.common.cancel}</button>
      </span>
    );
  }
  if (task.status === 'cancelled') {
    return (
      <span role="status" aria-live="polite" className="flex items-center gap-1.5 whitespace-nowrap text-xs text-ink-400">
        {t.reader.indexCancelled}
        <button className="rounded px-1 underline-offset-2 hover:text-ink-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-tea-500/50" onClick={onDismiss}>{t.reader.gotIt}</button>
      </span>
    );
  }
  return (
    <span role="alert" className="flex items-center gap-1.5 whitespace-nowrap text-xs text-cinnabar-600" title={task.error}>
      {t.reader.indexFailed}
      <button className="rounded px-1 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-tea-500/50" onClick={onDismiss}>{t.reader.gotIt}</button>
    </span>
  );
}
