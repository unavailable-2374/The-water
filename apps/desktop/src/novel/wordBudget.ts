/**
 * Word-count budgeting for chapter generation (plan §3.4). Pure functions.
 * All counts are 起点式 characters (see `countZh` in @the-water/shared).
 */
import type { ProviderCaps } from '@/llm/types';

export const DEFAULT_CHARS_PER_CHAPTER = 3000;
export const MIN_CHAPTERS = 3;
export const MAX_CHAPTERS = 150;
/** A chapter can never be re-budgeted below this many characters. */
export const MIN_CHAPTER_TARGET = 500;
/** Chapters above this target are written as two halves. */
export const SPLIT_CHAPTER_THRESHOLD = 4500;

export const EXPAND_BELOW_RATIO = 0.88;
export const TRIM_ABOVE_RATIO = 1.2;
export const ASK_RATIO = 1.08;
export const MIN_ACCEPTABLE_RATIO = 0.9;
export const REDISTRIBUTE_CLAMP = 0.3;

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export interface PlanChapterCountOptions {
  perChapter?: number;
  min?: number;
  max?: number;
}

export function planChapterCount(targetChars: number, opts: PlanChapterCountOptions = {}): number {
  const per = opts.perChapter && opts.perChapter > 0 ? opts.perChapter : DEFAULT_CHARS_PER_CHAPTER;
  const min = opts.min ?? MIN_CHAPTERS;
  const max = opts.max ?? MAX_CHAPTERS;
  return clamp(Math.round(targetChars / per), min, max);
}

/**
 * Scale `targets` so that their integer sum equals `total`. The rounding
 * remainder is assigned to the largest target. Non-positive input sums fall
 * back to an even split.
 */
export function normalizeTargets(targets: number[], total: number): number[] {
  const n = targets.length;
  if (n === 0) return [];
  const safeTotal = Math.max(0, Math.round(total));
  const clean = targets.map((t) => (Number.isFinite(t) && t > 0 ? t : 0));
  const sum = clean.reduce((a, b) => a + b, 0);
  const weights = sum > 0 ? clean : clean.map(() => 1);
  const wsum = sum > 0 ? sum : n;
  const scaled = weights.map((w) => Math.floor((w * safeTotal) / wsum));
  const remainder = safeTotal - scaled.reduce((a, b) => a + b, 0);
  let largest = 0;
  for (let i = 1; i < n; i++) if (weights[i]! > weights[largest]!) largest = i;
  scaled[largest]! += remainder;
  return scaled;
}

export type LengthAction = 'ok' | 'expand' | 'trim';

export function lengthAction(actual: number, target: number): LengthAction {
  if (target <= 0) return 'ok';
  if (actual < EXPAND_BELOW_RATIO * target) return 'expand';
  if (actual > TRIM_ABOVE_RATIO * target) return 'trim';
  return 'ok';
}

export interface BudgetChapter {
  chapterNo: number;
  targetChars: number;
  originalTarget: number;
  done: boolean;
  actualChars: number;
}

/**
 * After some chapters are done, spread the remaining book budget over the
 * undone chapters proportionally to their original targets. Each new target is
 * clamped to ±30% of its original; the residual lands on the last undone
 * chapter (never below MIN_CHAPTER_TARGET).
 */
export function redistributeRemaining(chapters: BudgetChapter[], bookTarget: number): Map<number, number> {
  const out = new Map<number, number>();
  const undone = chapters.filter((c) => !c.done).sort((a, b) => a.chapterNo - b.chapterNo);
  if (undone.length === 0) return out;
  const doneActual = chapters.filter((c) => c.done).reduce((a, c) => a + Math.max(0, c.actualChars), 0);
  const remaining = Math.max(0, bookTarget - doneActual);

  const origs = undone.map((c) => Math.max(0, c.originalTarget || c.targetChars));
  const origSum = origs.reduce((a, b) => a + b, 0);
  const weights = origSum > 0 ? origs : origs.map(() => 1);
  const wsum = origSum > 0 ? origSum : undone.length;

  let assigned = 0;
  undone.forEach((c, i) => {
    const orig = origs[i]!;
    const raw = (remaining * weights[i]!) / wsum;
    const lo = Math.round(orig * (1 - REDISTRIBUTE_CLAMP));
    const hi = Math.round(orig * (1 + REDISTRIBUTE_CLAMP));
    const next = orig > 0 ? clamp(Math.round(raw), lo, hi) : Math.round(raw);
    out.set(c.chapterNo, next);
    assigned += next;
  });

  const last = undone[undone.length - 1]!;
  const residual = remaining - assigned;
  out.set(last.chapterNo, Math.max(MIN_CHAPTER_TARGET, out.get(last.chapterNo)! + residual));
  return out;
}

/** What we ask the model for: slightly above target because models under-deliver. */
export function askedTarget(target: number): number {
  return Math.round(target * ASK_RATIO);
}

export function minAcceptable(target: number): number {
  return Math.round(target * MIN_ACCEPTABLE_RATIO);
}

export function maxTokensForChapter(target: number, caps: Pick<ProviderCaps, 'maxOutputTokens'>): number {
  return Math.max(1, Math.min(caps.maxOutputTokens, Math.ceil(target * 1.6) + 400));
}

export function shouldSplitChapter(target: number): boolean {
  return target > SPLIT_CHAPTER_THRESHOLD;
}
