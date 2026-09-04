import { useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useReader } from '@/stores/readerStore';
import { PageView } from './PageView';
import { SelectionPopover } from './SelectionPopover';

const GAP = 12;

/** Virtualized vertical page list. Renders pages near the viewport, keeps placeholders for the rest. */
export function PdfViewer({ pdf }: { pdf: PDFDocumentProxy }) {
  const scale = useReader((s) => s.scale);
  const setCurrentPage = useReader((s) => s.setCurrentPage);
  const scrollToPage = useReader((s) => s.scrollToPage);
  const consumeJump = useReader((s) => s.consumeJump);
  const containerRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<Array<{ w: number; h: number }>>([]);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(800);

  // page sizes at scale 1 (points)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const first = await pdf.getPage(1);
      const vp = first.getViewport({ scale: 1 });
      const base = { w: vp.width, h: vp.height };
      const arr = Array.from({ length: pdf.numPages }, () => base);
      if (!cancelled) setSizes(arr);
      // refine sizes lazily for mixed-size docs
      for (let i = 2; i <= Math.min(pdf.numPages, 400); i++) {
        const p = await pdf.getPage(i);
        const v = p.getViewport({ scale: 1 });
        if (cancelled) return;
        if (Math.abs(v.width - base.w) > 1 || Math.abs(v.height - base.h) > 1) {
          setSizes((s) => { const n = [...s]; n[i - 1] = { w: v.width, h: v.height }; return n; });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [pdf]);

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

  // jump requests
  useEffect(() => {
    if (scrollToPage == null || layout.tops.length === 0) return;
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = (layout.tops[scrollToPage - 1] ?? 0) - GAP;
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
    <div ref={containerRef} onScroll={onScroll} className="relative h-full overflow-auto scrollbar-thin">
      <div style={{ height: layout.total, position: 'relative' }}>
        {visible.map((n) => (
          <div key={n} style={{ position: 'absolute', top: layout.tops[n - 1], left: 0, right: 0, display: 'flex', justifyContent: 'center' }}>
            <div className="shadow-book">
              <PageView pdf={pdf} pageNo={n} width={sizes[n - 1]!.w * scale} height={sizes[n - 1]!.h * scale} />
            </div>
          </div>
        ))}
      </div>
      <SelectionPopover />
    </div>
  );
}
