import type { Rect } from '@/pdf/anchor';

export interface HitRects {
  rects: Rect[];
  active: boolean;
}

/** 页内搜索命中：当前那一条更醒目。 */
export function SearchHitLayer({ hits }: { hits: HitRects[] }) {
  if (hits.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-[2]">
      {hits.flatMap((h, hi) =>
        h.rects.map((r, i) => (
          <div
            key={`${hi}-${i}`}
            style={{
              position: 'absolute',
              left: `${r.x * 100}%`,
              top: `${r.y * 100}%`,
              width: `${r.w * 100}%`,
              height: `${r.h * 100}%`,
              background: h.active ? 'rgba(255,138,0,0.55)' : 'rgba(255,205,110,0.4)',
              outline: h.active ? '1.5px solid rgba(214,101,0,0.9)' : 'none',
              borderRadius: 2,
              mixBlendMode: 'multiply',
            }}
          />
        )),
      )}
    </div>
  );
}
