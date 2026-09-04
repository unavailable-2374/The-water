import { describe, expect, it } from 'vitest';
import { buildAnchor, locateAnchor, normalizePageText } from '@/pdf/anchor';

const page = normalizePageText('天地玄黄  宇宙洪荒\n日月盈昃 辰宿列张 寒来暑往 秋收冬藏 宇宙洪荒 闰余成岁');

describe('anchor', () => {
  it('builds prefix/suffix and locates by position', () => {
    const s = page.indexOf('日月');
    const a = buildAnchor(page, s, s + 4, []);
    expect(a.exact).toBe('日月盈昃');
    expect(a.prefix.endsWith('洪荒 ')).toBe(true);
    expect(locateAnchor(page, a)).toEqual({ start: s, end: s + 4 });
  });
  it('disambiguates repeated quotes with context', () => {
    const second = page.lastIndexOf('宇宙洪荒');
    const a = buildAnchor(page, second, second + 4, []);
    // simulate shifted text (inserted prefix)
    const shifted = '前言。' + page;
    const loc = locateAnchor(shifted, a);
    expect(loc).toEqual({ start: second + 3, end: second + 7 });
    const first = page.indexOf('宇宙洪荒');
    const b = buildAnchor(page, first, first + 4, []);
    expect(locateAnchor(shifted, b)).toEqual({ start: first + 3, end: first + 7 });
  });
  it('falls back to whitespace-insensitive match and null when missing', () => {
    const a = { exact: '辰宿列张寒来', prefix: '', suffix: '', start: null, end: null, rects: [] };
    const loc = locateAnchor(page, a);
    expect(loc).not.toBeNull();
    expect(page.slice(loc!.start, loc!.end).replace(/\s/g, '')).toBe('辰宿列张寒来');
    expect(locateAnchor(page, { ...a, exact: '不存在的' })).toBeNull();
  });
});
