import { describe, expect, it } from 'vitest';
import {
  askedTarget,
  lengthAction,
  maxTokensForChapter,
  minAcceptable,
  normalizeTargets,
  planChapterCount,
  redistributeRemaining,
  shouldSplitChapter,
  MIN_CHAPTER_TARGET,
  chapterCountForStory,
} from '@/novel/wordBudget';

describe('planChapterCount', () => {
  it('TEST accepted story arcs may expand or shrink the initial word-based estimate',()=>{
    expect(chapterCountForStory({arcs:[{endChapterNo:24}],chapters:[]},90000)).toBe(24);
    expect(chapterCountForStory({arcs:[{endChapterNo:42}],chapters:[]},90000)).toBe(42);
    expect(chapterCountForStory({arcs:[{endChapterNo:24}],chapters:[{chapterNo:30,title:'TEST existing',goal:'TEST goal'}]},90000)).toBe(30);
  });
  it('rounds target / 3000 and clamps to [3, 500]', () => {
    expect(planChapterCount(10_000)).toBe(3);
    expect(planChapterCount(1_000)).toBe(3);
    expect(planChapterCount(90_000)).toBe(30);
    expect(planChapterCount(91_000)).toBe(30);
    expect(planChapterCount(300_000)).toBe(100);
    expect(planChapterCount(1_000_000)).toBe(333);
  });
  it('supports a complete single-chapter short story without changing long-novel defaults',()=>{
    expect(planChapterCount(3000,{docType:'short-story'})).toBe(1);
    expect(planChapterCount(6000,{docType:'short-story'})).toBe(2);
    expect(planChapterCount(3000)).toBe(3);
  });
  it('honours options', () => {
    expect(planChapterCount(10_000, { perChapter: 2000 })).toBe(5);
    expect(planChapterCount(10_000, { perChapter: 2000, max: 4 })).toBe(4);
    expect(planChapterCount(100, { min: 1 })).toBe(1);
  });
});

describe('normalizeTargets', () => {
  it('keeps sum === total and gives the rounding remainder to the largest', () => {
    const out = normalizeTargets([1000, 1000, 1000], 10_000);
    expect(out.reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(out).toEqual([3334, 3333, 3333]);
    const out2 = normalizeTargets([1000, 3000, 2000], 10_001);
    expect(out2.reduce((a, b) => a + b, 0)).toBe(10_001);
    expect(out2[1]).toBeGreaterThan(out2[2]!);
    expect(out2[2]).toBeGreaterThan(out2[0]!);
  });
  it('sum invariant holds across many random inputs', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let k = 0; k < 200; k++) {
      const n = 1 + Math.floor(rnd() * 60);
      const targets = Array.from({ length: n }, () => Math.floor(rnd() * 5000));
      const total = Math.floor(rnd() * 300_000);
      const out = normalizeTargets(targets, total);
      expect(out).toHaveLength(n);
      expect(out.reduce((a, b) => a + b, 0)).toBe(total);
      expect(out.every((x) => Number.isInteger(x) && x >= 0)).toBe(true);
    }
  });
  it('splits evenly when the input sum is zero, and handles empty input', () => {
    expect(normalizeTargets([0, 0, 0], 10)).toEqual([4, 3, 3]);
    expect(normalizeTargets([], 10)).toEqual([]);
  });
});

describe('lengthAction', () => {
  it('expands below 88% and trims above 120%', () => {
    expect(lengthAction(2639, 3000)).toBe('expand');
    expect(lengthAction(2640, 3000)).toBe('ok');
    expect(lengthAction(3600, 3000)).toBe('ok');
    expect(lengthAction(3601, 3000)).toBe('trim');
    expect(lengthAction(0, 0)).toBe('ok');
  });
});

describe('redistributeRemaining', () => {
  const mk = (chapterNo: number, done: boolean, actual = 0, target = 3000) => ({ chapterNo, targetChars: target, originalTarget: target, done, actualChars: actual });

  it('spreads the remaining budget over undone chapters and preserves the book total', () => {
    const chapters = [mk(1, true, 2500), mk(2, true, 2600), mk(3, false), mk(4, false), mk(5, false)];
    const out = redistributeRemaining(chapters, 15_000);
    expect([...out.keys()]).toEqual([3, 4, 5]);
    const sum = [...out.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBe(15_000 - 2500 - 2600);
    for (const v of out.values()) expect(v).toBeGreaterThanOrEqual(3000);
  });

  it('clamps each chapter to ±30% of its original and dumps the residual on the last', () => {
    const chapters = [mk(1, true, 500), mk(2, false), mk(3, false), mk(4, false)];
    const out = redistributeRemaining(chapters, 30_000); // remaining 29500 over 3 chapters → 9833 each, clamp to 3900
    expect(out.get(2)).toBe(3900);
    expect(out.get(3)).toBe(3900);
    expect(out.get(4)).toBe(29_500 - 3900 - 3900);
  });

  it('never drops the last undone chapter below the floor', () => {
    const chapters = [mk(1, true, 20_000), mk(2, false), mk(3, false)];
    const out = redistributeRemaining(chapters, 9_000); // remaining 0
    expect(out.get(2)).toBe(2100);
    expect(out.get(3)).toBe(MIN_CHAPTER_TARGET);
  });

  it('returns an empty map when everything is done', () => {
    expect(redistributeRemaining([mk(1, true, 3000)], 3000).size).toBe(0);
  });
});

describe('ratios & tokens', () => {
  it('asked / min targets', () => {
    expect(askedTarget(3000)).toBe(3240);
    expect(minAcceptable(3000)).toBe(2700);
  });
  it('maxTokensForChapter is capped by provider output limit', () => {
    expect(maxTokensForChapter(3000, { maxOutputTokens: 8192 })).toBe(8192);
    expect(maxTokensForChapter(3000, { maxOutputTokens: 16000 })).toBe(10000);
    expect(maxTokensForChapter(6000, { maxOutputTokens: 8192 })).toBe(8192);
  });
  it('shouldSplitChapter above 4500', () => {
    expect(shouldSplitChapter(4500)).toBe(false);
    expect(shouldSplitChapter(4501)).toBe(true);
  });
});
