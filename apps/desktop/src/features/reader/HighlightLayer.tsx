import { useReader } from '@/stores/readerStore';
import { colorCss } from './colors';

/** 只画本页的高亮：按页索引直接取，不再每次过滤全量。 */
export function HighlightLayer({ pageNo }: { pageNo: number }) {
  const mine = useReader((s) => s.byPage[pageNo]);
  const locations = useReader((s) => s.locations);
  const focus = useReader((s) => s.focusHighlightId);
  if (!mine || mine.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-[1]">
      {mine.flatMap((h) => {
        // 重定位失败的先不画：宁可不显示，也不要画在错的地方（笔记面板会标「无法定位」）
        if (locations[h.id]?.status === 'missing') return [];
        return h.anchor.rects.map((r, i) => (
          <div
            key={`${h.id}-${i}`}
            title={h.noteText || h.anchor.exact}
            className={focus === h.id ? 'outline outline-2 outline-offset-1 outline-tea-500/80' : ''}
            style={{
              position: 'absolute',
              left: `${r.x * 100}%`,
              top: `${r.y * 100}%`,
              width: `${r.w * 100}%`,
              height: `${r.h * 100}%`,
              background: colorCss(h.color),
              borderRadius: 2,
              mixBlendMode: 'multiply',
            }}
          />
        ));
      })}
    </div>
  );
}
