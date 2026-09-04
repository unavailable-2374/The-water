import { describe, expect, it } from 'vitest';
import { avatarGradient, avatarHue, avatarInitial, hashHue, hashSeed } from '@/community/avatar';
import { levelView } from '@/community/level';
import { activityVerb } from '@/community/feedText';
import { wrapLines } from '@/community/textWrap';
import { authorShareUrl, novelShareTarget, novelShareUrl } from '@/community/shareCard';
import type { NovelDetail } from '@the-water/shared';

describe('avatar', () => {
  it('is deterministic and stays inside the book palette', () => {
    expect(hashSeed('abc')).toBe(hashSeed('abc'));
    const palette = [18, 28, 40, 150, 165, 190, 205, 350, 10, 95];
    for (const seed of ['a', 'linwan', '灯下长街', '']) expect(palette).toContain(hashHue(seed));
    expect(avatarHue('linwan')).toBe(avatarHue('linwan'));
    expect(avatarHue('linwan')).toBeLessThan(360);
    expect(avatarGradient('x')).toBe(avatarGradient('x'));
  });
  it('takes the first grapheme of the display name', () => {
    expect(avatarInitial('林晚')).toBe('林');
    expect(avatarInitial('  Élodie')).toBe('É');
    expect(avatarInitial('')).toBe('?');
  });
});

describe('levelView', () => {
  it('reports progress and the gap to the next level', () => {
    expect(levelView(0)).toMatchObject({ ratio: 0, remaining: 100 });
    expect(levelView(200).ratio).toBeCloseTo(0.5);
    expect(levelView(200).remaining).toBe(100);
    expect(levelView(20_000)).toMatchObject({ ratio: 1, remaining: null });
  });
});

describe('activityVerb', () => {
  const novel = { title: '灯下长街', isDerivative: false };
  it('describes each activity kind', () => {
    expect(activityVerb({ kind: 'novel_published', novel })).toBe('发布了新故事');
    expect(activityVerb({ kind: 'version_published', novel, version: { versionNumber: 3 } })).toBe('更新到第 3 版');
    expect(activityVerb({ kind: 'novel_completed', novel })).toBe('写完了这个故事');
  });
  it('names the source when a derivative is published', () => {
    expect(activityVerb({ kind: 'novel_published', novel: { title: '续', isDerivative: true }, source: { title: '原作' } })).toBe('发布了《原作》的二创');
    // 没有来源信息时退回通用文案，不编造书名。
    expect(activityVerb({ kind: 'novel_published', novel: { title: '续', isDerivative: true }, source: null })).toBe('发布了新故事');
  });
});

describe('wrapLines', () => {
  const measure = (s: string) => s.length * 10;
  it('wraps by width and keeps every character when it fits', () => {
    expect(wrapLines('一二三四五六', 30, measure, 5)).toEqual(['一二三', '四五六']);
    expect(wrapLines('', 100, measure, 3)).toEqual([]);
  });
  it('adds an ellipsis when the text exceeds maxLines', () => {
    const lines = wrapLines('一二三四五六七八九十', 30, measure, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith('…')).toBe(true);
  });
});

describe('share links', () => {
  const novel = {
    id: 'n1',
    title: '灯下长街',
    summary: '雪夜守灯人的故事。',
    author: { id: 'a1', displayName: '林晚', handle: 'linwan' },
    chapterCount: 12,
    charCount: 36_000,
    writingStatus: 'ongoing',
    likeCount: 3,
    isDerivative: false,
    shareUrl: null,
    source: null,
  } as unknown as NovelDetail;

  it('falls back to the server web page and never emits a hash route', () => {
    expect(novelShareUrl(novel, 'http://localhost:8787/')).toBe('http://localhost:8787/n/n1');
    expect(novelShareUrl({ ...novel, shareUrl: 'https://water.example/n/n1' }, 'http://x')).toBe('https://water.example/n/n1');
    expect(authorShareUrl({ handle: 'linwan', shareUrl: null }, 'http://localhost:8787')).toBe('http://localhost:8787/u/linwan');
    const target = novelShareTarget(novel, 'http://localhost:8787');
    expect(target.text).not.toContain('#/');
    expect(target.text).toContain('《灯下长街》');
    expect(target.text).toContain('http://localhost:8787/n/n1');
    expect(target.fileName).toBe('灯下长街-分享卡.png');
  });
});
