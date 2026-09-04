import type { Highlight } from '@/db/repos/highlightsRepo';

export type HighlightIndex = Record<number, Highlight[]>;

/**
 * 按页建索引：页面渲染只取自己那一页，不再每次过滤全量高亮。
 * 同一页内按创建时间排序，保证顺序稳定。
 */
export function indexByPage(highlights: Highlight[]): HighlightIndex {
  const out: HighlightIndex = {};
  for (const h of highlights) (out[h.pageNo] ??= []).push(h);
  for (const list of Object.values(out)) list.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  return out;
}

/** 乐观插入：返回新的列表（按页码、创建时间排序，与仓储层的查询口径一致）。 */
export function insertHighlight(list: Highlight[], h: Highlight): Highlight[] {
  return [...list.filter((x) => x.id !== h.id), h].sort(
    (a, b) => a.pageNo - b.pageNo || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
  );
}

/** 乐观改写一条。 */
export function patchHighlight(list: Highlight[], id: string, patch: Partial<Highlight>): Highlight[] {
  return list.map((h) => (h.id === id ? { ...h, ...patch } : h));
}

/** 乐观删除一条。 */
export function removeHighlight(list: Highlight[], id: string): Highlight[] {
  return list.filter((h) => h.id !== id);
}
