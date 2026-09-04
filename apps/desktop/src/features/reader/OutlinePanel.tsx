import { useEffect, useRef, useState } from 'react';
import { ChevronRight, List, Images } from 'lucide-react';
import { cn } from '@/components/ui';
import type { DocumentSource, OutlineNode } from '@/documents/types';
import { useReader } from '@/stores/readerStore';
import { READER_THEMES } from './theme';

/** 左侧栏：目录 + 缩略图。 */
export function OutlinePanel({ source }: { source: DocumentSource }) {
  const leftPanel = useReader((s) => s.leftPanel);
  const setLeftPanel = useReader((s) => s.setLeftPanel);
  const [outline, setOutline] = useState<OutlineNode[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setOutline(null);
    void source.getOutline().then((o) => { if (!cancelled) setOutline(o); });
    return () => { cancelled = true; };
  }, [source]);

  const tab = (key: 'outline' | 'thumbs', Icon: typeof List, label: string) => (
    <button
      onClick={() => setLeftPanel(key)}
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 rounded-full py-1 text-xs transition',
        leftPanel === key ? 'bg-paper-0 font-medium text-tea-700 shadow-soft dark:bg-paper-800 dark:text-tea-200' : 'text-ink-500 hover:text-ink-800 dark:text-ink-300',
      )}
    >
      <Icon size={13} strokeWidth={1.75} />
      {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="m-3 flex gap-0.5 rounded-full bg-paper-200/70 p-0.5 dark:bg-paper-800/70">
        {tab('outline', List, '目录')}
        {tab('thumbs', Images, '缩略图')}
      </div>
      {leftPanel === 'outline' ? <OutlineTree outline={outline} /> : <ThumbnailStrip source={source} />}
    </div>
  );
}

function OutlineTree({ outline }: { outline: OutlineNode[] | null }) {
  const jumpTo = useReader((s) => s.jumpTo);
  if (outline === null) return <p className="px-4 py-6 text-center font-serif text-xs text-ink-400">正在读目录…</p>;
  if (outline.length === 0) return <p className="px-4 py-6 text-center font-serif text-xs leading-relaxed text-ink-400">这本书没有目录。可以用缩略图或页码跳转。</p>;
  return (
    <div className="flex-1 overflow-y-auto px-2 pb-4 scrollbar-thin">
      {outline.map((n, i) => <OutlineItem key={i} node={n} depth={0} onJump={jumpTo} />)}
    </div>
  );
}

function OutlineItem({ node, depth, onJump }: { node: OutlineNode; depth: number; onJump: (page: number) => void }) {
  const [open, setOpen] = useState(depth < 1);
  const has = node.children.length > 0;
  return (
    <div>
      <div className="flex items-center gap-0.5" style={{ paddingLeft: depth * 12 }}>
        {has ? (
          <button onClick={() => setOpen((v) => !v)} className="shrink-0 rounded p-0.5 text-ink-400 hover:text-ink-700">
            <ChevronRight size={13} strokeWidth={1.75} className={cn('transition-transform', open && 'rotate-90')} />
          </button>
        ) : <span className="w-[18px]" />}
        <button
          onClick={() => node.pageNo && onJump(node.pageNo)}
          disabled={!node.pageNo}
          title={node.title}
          className={cn(
            'min-w-0 flex-1 truncate rounded-lg px-2 py-1 text-left font-serif text-[13px] leading-relaxed transition',
            node.pageNo ? 'text-ink-700 hover:bg-paper-200/60 dark:text-ink-300 dark:hover:bg-paper-800' : 'cursor-default text-ink-400',
          )}
        >
          {node.title}
        </button>
        {node.pageNo && <span className="shrink-0 pr-1 font-serif text-[11px] tabular-nums text-ink-400">{node.pageNo}</span>}
      </div>
      {open && node.children.map((c, i) => <OutlineItem key={i} node={c} depth={depth + 1} onJump={onJump} />)}
    </div>
  );
}

function ThumbnailStrip({ source }: { source: DocumentSource }) {
  const currentPage = useReader((s) => s.currentPage);
  const jumpTo = useReader((s) => s.jumpTo);
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [currentPage]);

  return (
    <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto px-3 pb-4 scrollbar-thin">
      {Array.from({ length: source.numPages }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          ref={n === currentPage ? activeRef : undefined}
          onClick={() => jumpTo(n)}
          className="block w-full"
        >
          <Thumbnail source={source} pageNo={n} active={n === currentPage} />
          <div className={cn('mt-0.5 text-center font-serif text-[11px] tabular-nums', n === currentPage ? 'text-tea-700 dark:text-tea-200' : 'text-ink-400')}>{n}</div>
        </button>
      ))}
    </div>
  );
}

const THUMB_W = 108;

function Thumbnail({ source, pageNo, active }: { source: DocumentSource; pageNo: number; active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  const [ratio, setRatio] = useState(1.414);
  const theme = READER_THEMES[useReader((s) => s.theme)];

  useEffect(() => {
    const el = boxRef.current;
    if (!el || seen) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); }
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  useEffect(() => {
    if (!seen) return;
    let cancelled = false;
    (async () => {
      const size = await source.pageSize(pageNo);
      if (cancelled) return;
      setRatio(size.height / size.width);
      if (source.renderMode !== 'canvas') return;
      const page = await source.pdf.getPage(pageNo);
      if (cancelled) return;
      const scale = THUMB_W / size.width;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      await page.render({ canvasContext: ctx, canvas, viewport }).promise.catch(() => undefined);
      page.cleanup();
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [seen, source, pageNo]);

  const preview = source.renderMode === 'text' ? source.pageBlocks(pageNo).map((b) => b.text).join(' ').slice(0, 90) : '';

  return (
    <div
      ref={boxRef}
      className={cn('mx-auto overflow-hidden rounded shadow-soft transition', active ? 'ring-2 ring-tea-500' : 'ring-1 ring-black/5')}
      style={{ width: THUMB_W, height: THUMB_W * ratio, background: theme.pageBg }}
    >
      {source.renderMode === 'canvas'
        ? <canvas ref={canvasRef} className="block h-full w-full" style={{ filter: theme.canvasFilter }} />
        : <div className="p-1.5 text-[5px] leading-[1.6]" style={{ color: theme.textColor }}>{preview}</div>}
    </div>
  );
}
