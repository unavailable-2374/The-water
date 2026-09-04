import { describe, expect, it } from 'vitest';
import {
  BADGES,
  DERIVATIVE_VIEW_SPLIT,
  LEVELS,
  POINT_RULES,
  PUBLISH_POINTS,
  PointKindSchema,
  badgesFor,
  emptyBadgeStats,
  levelFor,
  levelProgress,
} from '../src/incentive';

describe('levelFor', () => {
  it('maps points to the right level and next threshold', () => {
    expect(levelFor(0)).toEqual({ level: 1, title: '初涉', min: 0, next: 100 });
    expect(levelFor(99).level).toBe(1);
    expect(levelFor(100)).toEqual({ level: 2, title: '执笔', min: 100, next: 300 });
    expect(levelFor(12_000)).toEqual({ level: 7, title: '传世', min: 12_000, next: null });
    expect(levelFor(9_999_999).level).toBe(7);
  });
  it('treats junk input as zero', () => {
    expect(levelFor(-50).level).toBe(1);
    expect(levelFor(Number.NaN).level).toBe(1);
  });
});

describe('levelProgress', () => {
  it('is the fraction between this level and the next; 1 at max level', () => {
    expect(levelProgress(0)).toBe(0);
    expect(levelProgress(200)).toBeCloseTo(0.5);
    expect(levelProgress(20_000)).toBe(1);
  });
});

describe('LEVELS / POINT_RULES', () => {
  it('levels are strictly increasing and start at 0', () => {
    expect(LEVELS[0]!.min).toBe(0);
    for (let i = 1; i < LEVELS.length; i++) {
      expect(LEVELS[i]!.min).toBeGreaterThan(LEVELS[i - 1]!.min);
      expect(LEVELS[i]!.level).toBe(LEVELS[i - 1]!.level + 1);
    }
  });
  it('every point kind except adjustment has a positive rule', () => {
    for (const kind of PointKindSchema.options) {
      if (kind === 'adjustment') continue;
      const rule = POINT_RULES[kind];
      expect(rule, kind).toBeTruthy();
      expect(rule.points).toBeGreaterThan(0);
      expect(Number.isInteger(rule.points)).toBe(true);
    }
  });
  it('derivative view split adds up to the original view award', () => {
    expect(DERIVATIVE_VIEW_SPLIT.derivative + DERIVATIVE_VIEW_SPLIT.source).toBe(POINT_RULES.view_received.points);
    expect(POINT_RULES.view_shared.points).toBe(DERIVATIVE_VIEW_SPLIT.source);
    expect(PUBLISH_POINTS.original).toBeGreaterThan(PUBLISH_POINTS.derivative);
  });
});

describe('badgesFor', () => {
  it('awards nothing to a brand new account', () => {
    expect(badgesFor(emptyBadgeStats())).toEqual([]);
  });
  it('awards publishing, derivative and follower badges as thresholds are met', () => {
    const got = badgesFor({ ...emptyBadgeStats(), novelCount: 1, derivativeCount: 1, derivedCount: 1, followerCount: 10 });
    expect(got).toContain('first_publish');
    expect(got).toContain('first_derivative');
    expect(got).toContain('forked_1');
    expect(got).toContain('followers_10');
    expect(got).not.toContain('followers_100');
    expect(got).not.toContain('forked_10');
  });
  it('awards level badges from points alone', () => {
    expect(badgesFor({ ...emptyBadgeStats(), points: 300 })).toEqual(['level_3']);
    expect(badgesFor({ ...emptyBadgeStats(), points: 12_000 })).toEqual(['level_3', 'level_5', 'level_7']);
  });
  it('badge ids are unique', () => {
    expect(new Set(BADGES.map((b) => b.id)).size).toBe(BADGES.length);
  });
});
