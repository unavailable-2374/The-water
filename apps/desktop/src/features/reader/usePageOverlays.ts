import { useEffect, useState, type RefObject } from 'react';
import { findMatches } from '@/documents/fts';
import type { TextMap } from '@/documents/domText';
import { useReader } from '@/stores/readerStore';
import { rectsForSpan } from './pageRects';
import type { HitRects } from './SearchHitLayer';

/**
 * 页面渲染完成后：
 * 1) 把「重定位后位置变了」的高亮矩形按新位置修好（并写回库，下次打开就不用再修）；
 * 2) 算出本页搜索命中的矩形。
 * 两件事都依赖文字层 DOM 与规范化文本的偏移映射。
 */
export function usePageOverlays(
  pageNo: number,
  mapRef: RefObject<TextMap | null>,
  wrapRef: RefObject<HTMLDivElement | null>,
  renderNonce: number,
): HitRects[] {
  const query = useReader((s) => s.search.query);
  const hits = useReader((s) => s.search.hits);
  const activeIndex = useReader((s) => s.search.index);
  const [hitRects, setHitRects] = useState<HitRects[]>([]);

  // 修矩形
  useEffect(() => {
    const map = mapRef.current;
    const wrap = wrapRef.current;
    if (!map || !wrap || renderNonce === 0) return;
    const state = useReader.getState();
    const mine = state.byPage[pageNo] ?? [];
    const box = wrap.getBoundingClientRect();
    for (const h of mine) {
      const loc = state.locations[h.id];
      if (!loc || loc.status !== 'moved' || loc.start == null || loc.end == null) continue;
      const rects = rectsForSpan(map, loc.start, loc.end, box);
      if (rects.length) void state.repairRects(h.id, rects);
    }
  }, [pageNo, renderNonce, mapRef, wrapRef]);

  // 搜索命中
  useEffect(() => {
    const map = mapRef.current;
    const wrap = wrapRef.current;
    if (!map || !wrap || renderNonce === 0 || !query) { setHitRects([]); return; }
    const mine = hits.map((h, i) => ({ hit: h, index: i })).filter((x) => x.hit.pageNo === pageNo);
    if (mine.length === 0) { setHitRects([]); return; }
    const box = wrap.getBoundingClientRect();
    const matches = findMatches(map.text, query);
    const out: HitRects[] = [];
    for (const { hit, index } of mine) {
      const m = matches[hit.occurrence];
      if (!m) continue;
      const rects = rectsForSpan(map, m.start, m.end, box);
      if (rects.length) out.push({ rects, active: index === activeIndex });
    }
    setHitRects(out);
  }, [pageNo, renderNonce, query, hits, activeIndex, mapRef, wrapRef]);

  return hitRects;
}
