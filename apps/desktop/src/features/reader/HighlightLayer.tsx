import { useReader } from '@/stores/readerStore';

const COLORS: Record<string, string> = {
  yellow: 'var(--color-highlight-yellow)',
  green: 'var(--color-highlight-green)',
  blue: 'var(--color-highlight-blue)',
  pink: 'var(--color-highlight-pink)',
};

export function HighlightLayer({ pageNo }: { pageNo: number }) {
  const highlights = useReader((s) => s.highlights);
  const focus = useReader((s) => s.focusHighlightId);
  const mine = highlights.filter((h) => h.pageNo === pageNo);
  if (mine.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-[1]">
      {mine.flatMap((h) =>
        h.anchor.rects.map((r, i) => (
          <div
            key={`${h.id}-${i}`}
            title={h.noteText || h.anchor.exact}
            className={focus === h.id ? 'outline outline-2 outline-offset-1 outline-tea-500/80' : ''}
            style={{ position: 'absolute', left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%`, background: COLORS[h.color] ?? COLORS.yellow, borderRadius: 2, mixBlendMode: 'multiply' }}
          />
        )),
      )}
    </div>
  );
}
