import { describe, expect, it } from 'vitest';
import {
  HandleSchema,
  RESERVED_HANDLES,
  avatarSvg,
  buildShareText,
  fallbackHandle,
  hueFromSeed,
  validateHandle,
} from '../src/community';

describe('HandleSchema / validateHandle', () => {
  it('accepts letters, digits and underscore, lowercasing input', () => {
    expect(HandleSchema.parse('Ink_42')).toBe('ink_42');
    expect(HandleSchema.parse('  abc  ')).toBe('abc');
    expect(validateHandle('Ink_42')).toBeNull();
  });
  it('rejects short, long, non-ascii and punctuated handles', () => {
    expect(HandleSchema.safeParse('ab').success).toBe(false);
    expect(HandleSchema.safeParse('a'.repeat(21)).success).toBe(false);
    expect(HandleSchema.safeParse('有中文').success).toBe(false);
    expect(HandleSchema.safeParse('a-b').success).toBe(false);
    expect(validateHandle('ab')).toBeTruthy();
    expect(validateHandle('')).toBeTruthy();
  });
  it('rejects reserved handles', () => {
    expect(HandleSchema.safeParse('admin').success).toBe(false);
    expect(validateHandle('FEED')).toBeTruthy();
    expect(RESERVED_HANDLES).toContain('me');
  });
});

describe('fallbackHandle', () => {
  it('is stable, valid, and differs for ids sharing a timestamp prefix', () => {
    const a = fallbackHandle('0192f0a1-7c2e-7abc-8def-0123456789ab');
    const b = fallbackHandle('0192f0a1-7c2e-7abc-8def-0123456789ff');
    expect(a).toBe(fallbackHandle('0192f0a1-7c2e-7abc-8def-0123456789ab'));
    expect(a).not.toBe(b);
    expect(validateHandle(a)).toBeNull();
  });
});

describe('buildShareText', () => {
  const base = {
    title: '灯下长街',
    summary: '雪夜守灯人的故事。',
    authorName: '林晚',
    handle: 'linwan',
    chapterCount: 12,
    charCount: 36_000,
    writingStatus: 'ongoing' as const,
    likeCount: 8,
  };
  it('includes title, author, stats and the url', () => {
    const text = buildShareText(base, 'https://water.example/n/abc');
    expect(text).toContain('《灯下长街》');
    expect(text).toContain('@linwan');
    expect(text).toContain('12 章');
    expect(text).toContain('连载中');
    expect(text).toContain('https://water.example/n/abc');
    expect(text).toContain('The Water');
  });
  it('never emits a desktop hash route', () => {
    expect(buildShareText(base, 'https://water.example/n/abc')).not.toContain('#/');
  });
  it('omits missing pieces and truncates a long summary', () => {
    const text = buildShareText({ title: '无名', authorName: '佚名' }, 'https://x/n/1');
    expect(text).not.toContain('（@');
    expect(text.split('\n')).toHaveLength(3);
    const long = buildShareText({ ...base, summary: '字'.repeat(200) }, 'https://x/n/1');
    expect(long).toContain('…');
    expect(long.split('\n')[2]!.length).toBeLessThanOrEqual(81);
  });
  it('mentions the source for a derivative', () => {
    const text = buildShareText({ ...base, isDerivative: true, sourceTitle: '原作' }, 'https://x/n/1');
    expect(text).toContain('改编自《原作》');
  });
});

describe('avatarSvg / hueFromSeed', () => {
  it('is deterministic per seed and varies across seeds', () => {
    expect(hueFromSeed('a')).toBe(hueFromSeed('a'));
    expect(hueFromSeed('a')).not.toBe(hueFromSeed('b'));
    expect(hueFromSeed('')).toBeGreaterThanOrEqual(0);
    expect(avatarSvg('u1')).toBe(avatarSvg('u1'));
    expect(avatarSvg('u1')).not.toBe(avatarSvg('u2'));
  });
  it('produces a self-contained svg with no script or external reference', () => {
    const svg = avatarSvg('u1', 128);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('width="128"');
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('<image');
    expect(svg).not.toMatch(/href=/);
    // 唯一的外部 URL 只能是 SVG 命名空间声明本身。
    expect(svg.match(/https?:\/\/[^"]+/g)).toEqual(['http://www.w3.org/2000/svg']);
  });
});
