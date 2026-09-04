/**
 * Local token estimator for prompt budgeting: `cjk * ratio + other / 4`.
 * Kept here (not in llm/tokens.ts) so the prompt layer has no coupling to the
 * transport layer.
 */

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/gu;

export const DEFAULT_CJK_TOKEN_RATIO = 0.7;

/** Count code points, splitting into CJK-ish and everything else. */
export function countCjkAndOther(text: string): { cjk: number; other: number } {
  if (!text) return { cjk: 0, other: 0 };
  const cjk = text.match(CJK_RE)?.length ?? 0;
  const total = Array.from(text).length;
  return { cjk, other: total - cjk };
}

export function estimateTokens(text: string, cjkRatio: number = DEFAULT_CJK_TOKEN_RATIO): number {
  const { cjk, other } = countCjkAndOther(text);
  return Math.ceil(cjk * cjkRatio + other / 4);
}

/** Keep the head of `text` so that it fits in `maxTokens`. */
export function truncateHead(text: string, maxTokens: number, cjkRatio: number = DEFAULT_CJK_TOKEN_RATIO): string {
  if (maxTokens <= 0) return '';
  if (estimateTokens(text, cjkRatio) <= maxTokens) return text;
  const cps = Array.from(text);
  let lo = 0;
  let hi = cps.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (estimateTokens(cps.slice(0, mid).join(''), cjkRatio) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return cps.slice(0, lo).join('');
}

/** Keep the tail of `text` so that it fits in `maxTokens`. */
export function truncateTail(text: string, maxTokens: number, cjkRatio: number = DEFAULT_CJK_TOKEN_RATIO): string {
  if (maxTokens <= 0) return '';
  if (estimateTokens(text, cjkRatio) <= maxTokens) return text;
  const cps = Array.from(text);
  let lo = 0;
  let hi = cps.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (estimateTokens(cps.slice(cps.length - mid).join(''), cjkRatio) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return cps.slice(cps.length - lo).join('');
}
