import { normalizeRects, type Rect } from '@/pdf/anchor';
import { spanToDom, type TextMap } from '@/documents/domText';

/** 把规范化文本上的一段偏移，换算成页面上的归一化矩形。 */
export function rectsForSpan(map: TextMap, start: number, end: number, pageBox: DOMRectReadOnly): Rect[] {
  const span = spanToDom(map, start, end);
  if (!span) return [];
  try {
    const range = document.createRange();
    range.setStart(span.startNode, Math.min(span.startOffset, span.startNode.length));
    range.setEnd(span.endNode, Math.min(span.endOffset, span.endNode.length));
    return normalizeRects(range.getClientRects(), pageBox);
  } catch {
    return [];
  }
}
