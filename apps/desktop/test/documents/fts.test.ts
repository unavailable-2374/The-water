import { describe, expect, it } from 'vitest';
import { findMatches, ftsIndexText, ftsMatchQuery, isCjk, splitRuns } from '@/documents/fts';

describe('FTS 二元切分', () => {
  it('汉字串切成重叠 bigram，并补一个末字', () => {
    expect(ftsIndexText('中国人民')).toBe('中国 国人 人民 民');
    expect(ftsIndexText('水')).toBe('水');
  });

  it('西文按词保留并小写，标点丢弃', () => {
    expect(ftsIndexText('The Water, v2!')).toBe('the water v2');
  });

  it('中西混排各自成段', () => {
    expect(ftsIndexText('AI 讨论')).toBe('ai 讨论 论');
    expect(splitRuns('AI 讨论').map((r) => r.cjk)).toEqual([false, true]);
  });

  it('查询：双字以上拼成短语，单字走前缀匹配', () => {
    expect(ftsMatchQuery('人民')).toBe('"人民"');
    expect(ftsMatchQuery('中华人民')).toBe('"中华 华人 人民"');
    expect(ftsMatchQuery('民')).toBe('"民"*');
    expect(ftsMatchQuery('the water')).toBe('"the" AND "water"');
    expect(ftsMatchQuery('AI 讨论')).toBe('"ai" AND "讨论"');
  });

  it('查询里没有可用字符时返回 null', () => {
    expect(ftsMatchQuery('   ')).toBeNull();
    expect(ftsMatchQuery('，。！')).toBeNull();
  });

  it('查询短语一定是入库 token 串的连续子序列', () => {
    const body = ftsIndexText('中华人民共和国万岁').split(' ');
    const phrase = ftsMatchQuery('人民共和')!.replace(/"/g, '').split(' ');
    const at = body.findIndex((tk) => tk === phrase[0]);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(body.slice(at, at + phrase.length)).toEqual(phrase);
  });

  it('isCjk 认得汉字、假名与谚文，不认西文', () => {
    expect(isCjk('水')).toBe(true);
    expect(isCjk('ア')).toBe(true);
    expect(isCjk('한')).toBe(true);
    expect(isCjk('a')).toBe(false);
  });
});

describe('页内命中', () => {
  const page = '宇宙洪荒，天地玄黄。宇宙很大，人也很小。';

  it('找出全部命中并给出片段与片段内偏移', () => {
    const ms = findMatches(page, '宇宙');
    expect(ms).toHaveLength(2);
    expect(ms[0]!.start).toBe(0);
    expect(page.slice(ms[1]!.start, ms[1]!.end)).toBe('宇宙');
    expect(ms[0]!.snippet.slice(ms[0]!.snippetStart, ms[0]!.snippetEnd)).toBe('宇宙');
  });

  it('大小写不敏感，空查询返回空', () => {
    expect(findMatches('The Water', 'water')).toHaveLength(1);
    expect(findMatches(page, '   ')).toEqual([]);
  });

  it('命中不重叠', () => {
    expect(findMatches('aaaa', 'aa')).toHaveLength(2);
  });
});
