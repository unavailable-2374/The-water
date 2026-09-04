import { memo, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { pdfjs } from '@/pdf/pdfjs';
import { useReader } from '@/stores/readerStore';
import { HighlightLayer } from './HighlightLayer';
import { SearchHitLayer } from './SearchHitLayer';
import { usePageOverlays } from './usePageOverlays';
import { normalizeRects } from '@/pdf/anchor';
import { extractPageText } from '@/pdf/textIndex';
import { mapContainer, type TextMap } from '@/documents/domText';
import { READER_THEMES } from './theme';

interface Props { pdf: PDFDocumentProxy; pageNo: number; width: number; height: number }

export const PageView = memo(function PageView({ pdf, pageNo, width, height }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pageTextRef = useRef<string>('');
  const mapRef = useRef<TextMap | null>(null);
  const [renderNonce, setRenderNonce] = useState(0);
  const scale = useReader((s) => s.scale);
  const theme = READER_THEMES[useReader((s) => s.theme)];
  const hitRects = usePageOverlays(pageNo, mapRef, wrapRef, renderNonce);

  useEffect(() => {
    let cancelled = false;
    let task: RenderTask | null = null;
    (async () => {
      const page = await pdf.getPage(pageNo);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current!;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      task = page.render({ canvasContext: ctx, canvas, viewport });
      try { await task.promise; } catch { return; }
      if (cancelled) return;
      const container = textRef.current!;
      container.innerHTML = '';
      container.style.setProperty('--scale-factor', String(viewport.scale));
      const textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container, viewport });
      await textLayer.render();
      const end = document.createElement('div');
      end.className = 'endOfContent';
      container.appendChild(end);
      pageTextRef.current = await extractPageText(page);
      mapRef.current = mapContainer(container);
      if (!cancelled) setRenderNonce((n) => n + 1);
    })().catch((e) => console.error('render page failed', pageNo, e));
    return () => { cancelled = true; task?.cancel(); };
  }, [pdf, pageNo, scale]);

  const onMouseUp = () => {
    const sel = window.getSelection();
    const container = textRef.current;
    const wrap = wrapRef.current;
    if (!sel || sel.isCollapsed || !container || !wrap) return;
    if (!container.contains(sel.anchorNode) || !container.contains(sel.focusNode)) return;
    const range = sel.getRangeAt(0);
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text) return;
    // offsets in normalized page text (via textLayer text order)
    const pre = document.createRange();
    pre.selectNodeContents(container);
    pre.setEnd(range.startContainer, range.startOffset);
    const before = pre.toString().replace(/\s+/g, ' ');
    const pageText = pageTextRef.current;
    let start = -1;
    // locate by quote near the estimated offset
    const est = before.trim().length;
    const idx = pageText.indexOf(text);
    if (idx !== -1) {
      let bestIdx = idx;
      let cur = idx;
      while (cur !== -1) { if (Math.abs(cur - est) < Math.abs(bestIdx - est)) bestIdx = cur; cur = pageText.indexOf(text, cur + 1); }
      start = bestIdx;
    }
    const clientRects = range.getClientRects();
    const rects = normalizeRects(clientRects, wrap.getBoundingClientRect());
    const first = clientRects[0];
    const last = clientRects[clientRects.length - 1];
    useReader.getState().setSelection({
      pageNo, text, start, end: start === -1 ? -1 : start + text.length, rects,
      clientX: last ? last.right : 0, clientY: last ? last.bottom : 0, clientTop: first ? first.top : 0,
    });
  };

  return (
    <div ref={wrapRef} className="relative shadow" style={{ width, height, background: theme.pageBg }} onMouseUp={onMouseUp} data-page={pageNo}>
      <canvas ref={canvasRef} className="block" style={{ filter: theme.canvasFilter }} />
      <HighlightLayer pageNo={pageNo} />
      <SearchHitLayer hits={hitRects} />
      <div ref={textRef} className="textLayer" />
    </div>
  );
});
