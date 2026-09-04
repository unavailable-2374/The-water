import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentSource } from '@/documents/types';
import { useReader } from '@/stores/readerStore';
import { PageView } from './PageView';
import { TextPageView } from './TextPageView';
import { SelectionPopover } from './SelectionPopover';
import { READER_THEMES } from './theme';

const GAP = 12;

/** 竖向翻页列表：只渲染视口附近的页，其余留占位。PDF 与文本文档共用。 */
export function DocViewer({ source }: { source: DocumentSource }) {
  const scale = useReader((s) => s.scale);
  const zoomBy = useReader((s) => s.zoomBy);
  const setCurrentPage = useReader((s) => s.setCurrentPage);
  const scrollToPage = useReader((s) => s.scrollToPage);
  const consumeJump = useReader((s) => s.consumeJump);
  const theme = READER_THEMES[useReader((s) => s.theme)];
  const containerRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<Array<{ w: number; h: number }>>([]);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(800);

  // page sizes at scale 1 (points)
  useEffect(() => {
    let cancelled = false;
    setSizes([]);
    (async () => {
      const first = await source.pageSize(1);
      const base = { w: first.width, h: first.height };
      const arr = Array.from({ length: source.numPages }, () => base);
      if (!cancelled) setSizes(arr);
      if (source.renderMode !== 'canvas') return;
      // refine sizes lazily for mixed-size docs
      for (let i = 2; i <= Math.min(source.numPages, 400); i++) {
        const v = await source.pageSize(i);
        if (cancelled) return;
        if (Math.abs(v.width - base.w) > 1 || Math.abs(v.height - base.h) > 1) {
          setSizes((s) => { const n = [...s]; n[i - 1] = { w: v.width, h: v.height }; return n; });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [source]);

  const layout = useMemo(() => {
    let y = GAP;
    const tops: number[] = [];
    for (const s of sizes) { tops.push(y); y += s.h * scale + GAP; }
    return { tops, total: y };
  }, [sizes, scale]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Ctrl / Cmd + 滚轮缩放
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomBy(e.deltaY > 0 ? -0.1 : 0.1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  // jump requests
  useEffect(() => {
    if (scrollToPage == null || layout.tops.length === 0) return;
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = (layout.tops[Math.min(scrollToPage, layout.tops.length) - 1] ?? 0) - GAP;
    consumeJump();
  }, [scrollToPage, layout.tops.length]);

  // keep the same page anchored when zooming
  const prevScale = useRef(scale);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || prevScale.current === scale) return;
    el.scrollTop = (el.scrollTop * scale) / prevScale.current;
    prevScale.current = scale;
  }, [scale]);

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    const mid = el.scrollTop + el.clientHeight / 3;
    let page = 1;
    for (let i = 0; i < layout.tops.length; i++) { if (layout.tops[i]! <= mid) page = i + 1; else break; }
    setCurrentPage(page);
  };

  const visible: number[] = [];
  for (let i = 0; i < layout.tops.length; i++) {
    const top = layout.tops[i]!;
    const h = sizes[i]!.h * scale;
    if (top + h >= scrollTop - viewportH && top <= scrollTop + viewportH * 2) visible.push(i + 1);
  }

  return (
    <div ref={containerRef} onScroll={onScroll} className="relative h-full overflow-auto scrollbar-thin" style={theme.stageBg === 'transparent' ? undefined : { background: theme.stageBg }}>
      <div style={{ height: layout.total, position: 'relative' }}>
        {visible.map((n) => (
          <div key={n} style={{ position: 'absolute', top: layout.tops[n - 1], left: 0, right: 0, display: 'flex', justifyContent: 'center' }}>
            <div className="shadow-book">
              {source.renderMode === 'canvas' ? (
                <PageView pdf={source.pdf} pageNo={n} width={sizes[n - 1]!.w * scale} height={sizes[n - 1]!.h * scale} />
              ) : (
                <TextPageView source={source} pageNo={n} width={sizes[n - 1]!.w * scale} height={sizes[n - 1]!.h * scale} />
              )}
            </div>
          </div>
        ))}
      </div>
      <SelectionPopover />
    </div>
  );
}
