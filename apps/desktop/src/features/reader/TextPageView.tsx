import { memo, useEffect, useRef, useState } from 'react';
import type { TextBlock, TextDocumentSource } from '@/documents/types';
import { TEXT_PAGE_SIZE } from '@/documents/textSource';
import { mapContainer, offsetOfDomPoint, type TextMap } from '@/documents/domText';
import { normalizeRects } from '@/pdf/anchor';
import { useReader } from '@/stores/readerStore';
import { HighlightLayer } from './HighlightLayer';
import { SearchHitLayer } from './SearchHitLayer';
import { usePageOverlays } from './usePageOverlays';
import { READER_THEMES } from './theme';

interface Props { source: TextDocumentSource; pageNo: number; width: number; height: number }

/** TXT / Markdown 的一页：固定版心 + 整页缩放，和 PDF 共用高亮与命中图层。 */
export const TextPageView = memo(function TextPageView({ source, pageNo, width, height }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<TextMap | null>(null);
  const [renderNonce, setRenderNonce] = useState(0);
  const scale = useReader((s) => s.scale);
  const theme = READER_THEMES[useReader((s) => s.theme)];
  const blocks = source.pageBlocks(pageNo);
  const hitRects = usePageOverlays(pageNo, mapRef, wrapRef, renderNonce);

  useEffect(() => {
    if (!contentRef.current) return;
    mapRef.current = mapContainer(contentRef.current);
    setRenderNonce((n) => n + 1);
  }, [pageNo, source, scale]);

  const onMouseUp = () => {
    const sel = window.getSelection();
    const container = contentRef.current;
    const wrap = wrapRef.current;
    const map = mapRef.current;
    if (!sel || sel.isCollapsed || !container || !wrap || !map) return;
    if (!container.contains(sel.anchorNode) || !container.contains(sel.focusNode)) return;
    const range = sel.getRangeAt(0);
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text) return;
    const start = offsetOfDomPoint(map, range.startContainer, range.startOffset, 'start');
    const end = offsetOfDomPoint(map, range.endContainer, range.endOffset, 'end');
    const clientRects = range.getClientRects();
    const rects = normalizeRects(clientRects, wrap.getBoundingClientRect());
    const first = clientRects[0];
    const last = clientRects[clientRects.length - 1];
    useReader.getState().setSelection({
      pageNo,
      text,
      start: start >= 0 && end > start ? start : -1,
      end: start >= 0 && end > start ? end : -1,
      rects,
      clientX: last ? last.right : 0,
      clientY: last ? last.bottom : 0,
      clientTop: first ? first.top : 0,
    });
  };

  return (
    <div ref={wrapRef} className="relative overflow-hidden shadow" style={{ width, height, background: theme.pageBg }} onMouseUp={onMouseUp} data-page={pageNo}>
      <div
        ref={contentRef}
        className="select-text"
        style={{
          width: TEXT_PAGE_SIZE.width,
          height: TEXT_PAGE_SIZE.height,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          padding: '56px 48px',
          color: theme.textColor,
          boxSizing: 'border-box',
        }}
      >
        {blocks.map((b, i) => <Block key={i} block={b} muted={theme.mutedColor} />)}
      </div>
      <HighlightLayer pageNo={pageNo} />
      <SearchHitLayer hits={hitRects} />
    </div>
  );
});

function Block({ block, muted }: { block: TextBlock; muted: string }) {
  const base = { margin: '0 0 0.85em', lineHeight: 1.9, fontSize: 16 } as const;
  switch (block.type) {
    case 'h1':
      return <h1 style={{ ...base, fontSize: 24, fontWeight: 600, lineHeight: 1.5, margin: '0.2em 0 0.8em' }}>{block.text}</h1>;
    case 'h2':
      return <h2 style={{ ...base, fontSize: 20, fontWeight: 600, lineHeight: 1.5, margin: '0.6em 0 0.6em' }}>{block.text}</h2>;
    case 'h3':
      return <h3 style={{ ...base, fontSize: 17, fontWeight: 600, lineHeight: 1.6, margin: '0.6em 0 0.5em' }}>{block.text}</h3>;
    case 'quote':
      return <blockquote style={{ ...base, borderLeft: '2px solid currentColor', paddingLeft: 12, color: muted, margin: '0 0 0.85em' }}>{block.text}</blockquote>;
    case 'code':
      return <pre style={{ ...base, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, whiteSpace: 'pre-wrap', color: muted }}>{block.text}</pre>;
    case 'li':
      return <div style={{ ...base, paddingLeft: 18, textIndent: -12, margin: '0 0 0.35em' }}>{`· ${block.text}`}</div>;
    default:
      return <p style={{ ...base, textIndent: '2em' }}>{block.text}</p>;
  }
}
