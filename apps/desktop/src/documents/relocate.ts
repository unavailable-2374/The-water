import type { Anchor } from '@/db/repos/highlightsRepo';
import { locateAnchor } from '@/pdf/anchor';

/**
 * ok      —— 存的偏移仍然对得上
 * moved   —— 靠引文重新找到了，但位置变了（矩形需要重算）
 * missing —— 页面文本里已经找不到这段话（笔记面板标「无法定位」）
 * unknown —— 这一页还没建索引，无从判断，先按存的矩形画
 */
export type LocateStatus = 'ok' | 'moved' | 'missing' | 'unknown';

export interface Located {
  status: LocateStatus;
  start: number | null;
  end: number | null;
}

/** 单条锚点重定位。 */
export function relocateAnchor(pageText: string | null | undefined, anchor: Anchor): Located {
  if (pageText == null || pageText === '') return { status: 'unknown', start: anchor.start, end: anchor.end };
  if (!anchor.exact) return { status: 'missing', start: null, end: null };
  const found = locateAnchor(pageText, anchor);
  if (!found) return { status: 'missing', start: null, end: null };
  const same = anchor.start === found.start && anchor.end === found.end;
  return { status: same ? 'ok' : 'moved', start: found.start, end: found.end };
}

export interface LocatableHighlight {
  id: string;
  pageNo: number;
  anchor: Anchor;
}

/** 打开文档时整本重定位一遍。 */
export function relocateHighlights(
  highlights: LocatableHighlight[],
  pageTexts: Map<number, string>,
): Record<string, Located> {
  const out: Record<string, Located> = {};
  for (const h of highlights) out[h.id] = relocateAnchor(pageTexts.get(h.pageNo), h.anchor);
  return out;
}

/** 无法定位的条数，用于面板上给一个总数提示。 */
export function countMissing(locations: Record<string, Located>): number {
  return Object.values(locations).filter((l) => l.status === 'missing').length;
}
