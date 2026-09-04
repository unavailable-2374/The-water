import type { Anchor } from '@/db/repos/highlightsRepo';

export interface Rect { x: number; y: number; w: number; h: number }

/** Normalize text the same way for anchoring and for stored page text. */
export function normalizePageText(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

const CTX = 32;

/**
 * Build an anchor from a selection within normalized page text.
 * `start`/`end` are offsets into `pageText` (already normalized).
 */
export function buildAnchor(pageText: string, start: number, end: number, rects: Rect[]): Anchor {
  const s = Math.max(0, Math.min(start, end));
  const e = Math.min(pageText.length, Math.max(start, end));
  return {
    exact: pageText.slice(s, e),
    prefix: pageText.slice(Math.max(0, s - CTX), s),
    suffix: pageText.slice(e, e + CTX),
    start: s,
    end: e,
    rects,
  };
}

/**
 * Re-locate an anchor in (possibly re-extracted) page text.
 * Order: exact position match → unique quote → quote disambiguated by prefix/suffix → null.
 */
export function locateAnchor(pageText: string, anchor: Anchor): { start: number; end: number } | null {
  const { exact } = anchor;
  if (!exact) return null;
  if (anchor.start != null && anchor.end != null && pageText.slice(anchor.start, anchor.end) === exact) {
    return { start: anchor.start, end: anchor.end };
  }
  const candidates: number[] = [];
  let idx = pageText.indexOf(exact);
  while (idx !== -1 && candidates.length < 200) {
    candidates.push(idx);
    idx = pageText.indexOf(exact, idx + 1);
  }
  if (candidates.length === 0) {
    // try whitespace-insensitive match
    const loose = looseFind(pageText, exact);
    return loose;
  }
  if (candidates.length === 1) return { start: candidates[0]!, end: candidates[0]! + exact.length };
  let best = candidates[0]!;
  let bestScore = -1;
  for (const c of candidates) {
    const pre = pageText.slice(Math.max(0, c - CTX), c);
    const suf = pageText.slice(c + exact.length, c + exact.length + CTX);
    const score = commonSuffixLen(pre, anchor.prefix) + commonPrefixLen(suf, anchor.suffix) - (anchor.start != null ? Math.abs(c - anchor.start) / 1000 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return { start: best, end: best + exact.length };
}

function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
function commonSuffixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}
function looseFind(text: string, quote: string): { start: number; end: number } | null {
  const q = quote.replace(/\s+/g, '');
  if (!q) return null;
  // map compact index → original index
  const map: number[] = [];
  let compact = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) continue;
    map.push(i);
    compact += ch;
  }
  const i = compact.indexOf(q);
  if (i === -1) return null;
  return { start: map[i]!, end: map[i + q.length - 1]! + 1 };
}

/** Convert client rects to page-relative normalized rects (0..1), merging duplicates/lines. */
export function normalizeRects(clientRects: ArrayLike<DOMRectReadOnly>, pageBox: DOMRectReadOnly): Rect[] {
  const out: Rect[] = [];
  for (let i = 0; i < clientRects.length; i++) {
    const r = clientRects[i]!;
    if (r.width < 1 || r.height < 1) continue;
    const n: Rect = {
      x: (r.left - pageBox.left) / pageBox.width,
      y: (r.top - pageBox.top) / pageBox.height,
      w: r.width / pageBox.width,
      h: r.height / pageBox.height,
    };
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - n.y) < 0.002 && Math.abs(last.h - n.h) < 0.002 && n.x <= last.x + last.w + 0.005) {
      const right = Math.max(last.x + last.w, n.x + n.w);
      last.x = Math.min(last.x, n.x);
      last.w = right - last.x;
    } else out.push(n);
  }
  return out.map((r) => ({ x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) }));
}
const round = (v: number) => Math.round(v * 10000) / 10000;
