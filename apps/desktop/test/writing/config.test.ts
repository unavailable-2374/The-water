import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import {
  BIBLE_CAPS, DEFAULT_STYLE_CHECK, EXTRACT_STYLE, LEARNING, LINT, STYLE_CHECK_LIMITS, STYLE_METRICS, WORD_BUDGET,
  loadStyleCheckConfig, normalizeStyleCheck, saveStyleCheckConfig,
} from '@/novel/config';
import { BIBLE_CAPS as BIBLE_CAPS_REEXPORT } from '@/novel/bible';
import { PROMOTE_THRESHOLD } from '@/novel/learning';
import {
  ASK_RATIO, DEFAULT_CHARS_PER_CHAPTER, MAX_CHAPTERS, MIN_CHAPTERS, MIN_CHAPTER_TARGET, SPLIT_CHAPTER_THRESHOLD, maxTokensForChapter,
} from '@/novel/wordBudget';
import { sampleChapterNos } from '@/jobs/steps/extractStyleStep';

beforeEach(() => { useTestDb(); });

describe('novel/config is the single source of truth', () => {
  it('the old named exports still resolve to the config values', () => {
    expect(DEFAULT_CHARS_PER_CHAPTER).toBe(WORD_BUDGET.defaultCharsPerChapter);
    expect(MIN_CHAPTERS).toBe(WORD_BUDGET.minChapters);
    expect(MAX_CHAPTERS).toBe(WORD_BUDGET.maxChapters);
    expect(MIN_CHAPTER_TARGET).toBe(WORD_BUDGET.minChapterTarget);
    expect(SPLIT_CHAPTER_THRESHOLD).toBe(WORD_BUDGET.splitChapterThreshold);
    expect(ASK_RATIO).toBe(WORD_BUDGET.askRatio);
    expect(BIBLE_CAPS_REEXPORT).toBe(BIBLE_CAPS);
    expect(PROMOTE_THRESHOLD).toBe(LEARNING.promoteThreshold);
  });

  it('the output-token formula uses the config ratio and slack', () => {
    const caps = { maxOutputTokens: 100_000 };
    expect(maxTokensForChapter(3000, caps)).toBe(Math.ceil(3000 * WORD_BUDGET.maxTokensRatio) + WORD_BUDGET.maxTokensSlack);
    // 上限永远压不过供应商的 maxOutputTokens
    expect(maxTokensForChapter(3000, { maxOutputTokens: 100 })).toBe(100);
  });

  it('extract_style sampling follows EXTRACT_STYLE.sampleChapters', () => {
    expect(sampleChapterNos(200)).toHaveLength(EXTRACT_STYLE.sampleChapters);
  });

  it('values stay in ranges the rest of the code assumes', () => {
    expect(WORD_BUDGET.expandBelowRatio).toBeLessThan(1);
    expect(WORD_BUDGET.trimAboveRatio).toBeGreaterThan(1);
    expect(LINT.burstinessWarn).toBeGreaterThan(0);
    expect(LINT.aiTellPenaltyPerK).toBeGreaterThan(0);
    expect(STYLE_METRICS.hardMetricWeight).toBeGreaterThanOrEqual(1);
    expect(LEARNING.minPhraseLen).toBeLessThan(LEARNING.maxPhraseLen);
    expect(BIBLE_CAPS.timeline).toBeGreaterThan(BIBLE_CAPS.facts);
  });
});

describe('normalizeStyleCheck', () => {
  it('falls back to the defaults for junk input', () => {
    expect(normalizeStyleCheck(undefined)).toEqual(DEFAULT_STYLE_CHECK);
    expect(normalizeStyleCheck(null)).toEqual(DEFAULT_STYLE_CHECK);
    expect(normalizeStyleCheck('nope')).toEqual(DEFAULT_STYLE_CHECK);
    expect(normalizeStyleCheck({ maxRevisions: 'x', defaultFidelity: NaN })).toEqual(DEFAULT_STYLE_CHECK);
  });

  it('clamps to the documented limits and rounds the counters', () => {
    const hi = normalizeStyleCheck({ maxRevisions: 99, defaultFidelity: 5, llmScoreWeight: 3, maxInstructions: 999 });
    expect(hi).toEqual({
      maxRevisions: STYLE_CHECK_LIMITS.maxRevisions[1],
      defaultFidelity: STYLE_CHECK_LIMITS.defaultFidelity[1],
      llmScoreWeight: STYLE_CHECK_LIMITS.llmScoreWeight[1],
      maxInstructions: STYLE_CHECK_LIMITS.maxInstructions[1],
    });
    const lo = normalizeStyleCheck({ maxRevisions: -4, defaultFidelity: 0, llmScoreWeight: -1, maxInstructions: 0 });
    expect(lo.maxRevisions).toBe(STYLE_CHECK_LIMITS.maxRevisions[0]);
    expect(lo.defaultFidelity).toBe(STYLE_CHECK_LIMITS.defaultFidelity[0]);
    expect(lo.llmScoreWeight).toBe(STYLE_CHECK_LIMITS.llmScoreWeight[0]);
    expect(lo.maxInstructions).toBe(STYLE_CHECK_LIMITS.maxInstructions[0]);
    expect(normalizeStyleCheck({ maxRevisions: 1.6, maxInstructions: 7.4 })).toMatchObject({ maxRevisions: 2, maxInstructions: 7 });
  });

  it('keeps a partial patch and takes the default for the rest', () => {
    expect(normalizeStyleCheck({ maxRevisions: 0 })).toEqual({ ...DEFAULT_STYLE_CHECK, maxRevisions: 0 });
  });
});

describe('style-check config persistence', () => {
  it('defaults when nothing stored, then round-trips a partial patch', async () => {
    expect(await loadStyleCheckConfig()).toEqual(DEFAULT_STYLE_CHECK);
    const saved = await saveStyleCheckConfig({ maxRevisions: 3 });
    expect(saved).toEqual({ ...DEFAULT_STYLE_CHECK, maxRevisions: 3 });
    expect(await loadStyleCheckConfig()).toEqual(saved);
    // 后一次 patch 只改自己那一项
    await saveStyleCheckConfig({ defaultFidelity: 0.9 });
    expect(await loadStyleCheckConfig()).toEqual({ ...DEFAULT_STYLE_CHECK, maxRevisions: 3, defaultFidelity: 0.9 });
    // 越界的值在写入时就被夹住
    await saveStyleCheckConfig({ maxRevisions: 42 });
    expect((await loadStyleCheckConfig()).maxRevisions).toBe(STYLE_CHECK_LIMITS.maxRevisions[1]);
  });
});
