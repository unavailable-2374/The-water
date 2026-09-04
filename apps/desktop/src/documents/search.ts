import { findMatches } from './fts';

export interface SearchHit {
  pageNo: number;
  /** 本页内的第几次命中（从 0 开始）；页面高亮按这个序号在文字层里定位 */
  occurrence: number;
  start: number;
  end: number;
  snippet: string;
  snippetStart: number;
  snippetEnd: number;
}

export interface SearchOutcome {
  hits: SearchHit[];
  /** 命中条数被 maxHits 截断 */
  truncated: boolean;
  pages: number;
}

/** 把「命中页 + 整页文本」展开成逐条命中，供列表、计数与上一条/下一条使用。 */
export function buildSearchHits(
  pages: Array<{ pageNo: number; text: string }>,
  q: string,
  maxHits = 500,
): SearchOutcome {
  const hits: SearchHit[] = [];
  let truncated = false;
  let touched = 0;
  for (const page of pages) {
    const matches = findMatches(page.text, q);
    if (matches.length) touched++;
    for (let i = 0; i < matches.length; i++) {
      if (hits.length >= maxHits) {
        truncated = true;
        return { hits, truncated, pages: touched };
      }
      const m = matches[i]!;
      hits.push({ pageNo: page.pageNo, occurrence: i, start: m.start, end: m.end, snippet: m.snippet, snippetStart: m.snippetStart, snippetEnd: m.snippetEnd });
    }
  }
  return { hits, truncated, pages: touched };
}

/** 上一条 / 下一条：在命中列表里循环移动。 */
export function stepHit(total: number, current: number, delta: number): number {
  if (total <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : total - 1;
  return (current + delta + total) % total;
}
