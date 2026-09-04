import { describe, expect, it } from 'vitest';
import { countZh, countHanOnly, normalizeChapterText, splitChapters } from '../src/text';
import { hashChapterContent, canonicalJson, hashStoryline } from '../src/hash';

describe('countZh', () => {
  it('counts CJK chars and punctuation, ignores whitespace', () => {
    expect(countZh('你好，世界。')).toBe(6);
    expect(countZh('你 好\n世界')).toBe(4);
    expect(countZh('abc 你好')).toBe(5);
    expect(countZh('')).toBe(0);
  });
  it('countHanOnly ignores punctuation and ascii', () => {
    expect(countHanOnly('你好，世界 abc')).toBe(4);
  });
});

describe('normalizeChapterText', () => {
  it('normalizes CRLF and trailing whitespace but keeps inner blank lines', () => {
    expect(normalizeChapterText('a\r\n\r\nb  \n\n')).toBe('a\n\nb');
  });
  it('applies NFC', () => {
    expect(normalizeChapterText('é')).toBe('é');
  });
});

describe('hash', () => {
  it('is stable across CRLF / trailing whitespace differences', async () => {
    const a = await hashChapterContent('第一章\r\n正文  \r\n');
    const b = await hashChapterContent('第一章\n正文');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it('canonicalJson sorts keys and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }], e: undefined })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });
  it('hashStoryline is order independent', async () => {
    expect(await hashStoryline({ x: 1, y: 2 })).toBe(await hashStoryline({ y: 2, x: 1 }));
  });
});

describe('splitChapters', () => {
  it('splits on 第X章 headers', () => {
    const r = splitChapters('前言\n第一章 开始\n内容一\n\n第2章 继续\n内容二\n');
    expect(r.map((c) => c.title)).toEqual(['第一章 开始', '第2章 继续']);
    expect(r[1]!.content).toBe('内容二');
  });
  it('falls back to single chapter', () => {
    expect(splitChapters('没有标题的文本')).toEqual([{ title: '第一章', content: '没有标题的文本' }]);
  });
});
