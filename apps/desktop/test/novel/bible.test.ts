import { describe, expect, it } from 'vitest';
import { applyBibleDelta, bibleAppearances } from '@/novel/bible';
import { BibleDeltaSchema } from '@/novel/types';
import { makeBible, makeDoc } from '../fixtures/storyline';

describe('applyBibleDelta', () => {
  const doc = makeDoc();
  const before = makeBible();
  const delta = BibleDeltaSchema.parse({
    characterUpdates: [
      { name: '老沈', state: '决定追查', location: '警局', relationshipChanges: ['与周衍互不信任', '开始信任周衍'] },
      { name: '阿四', knowledge: '看见寄信人' },
      { name: '陌生女子', state: '出现在巷口' },
    ],
    newCharacters: [{ name: '陌生女子', role: '神秘人', description: '穿红雨衣' }, { name: '沈默', role: '主角', description: '不应覆盖' }],
    newFacts: ['林晚三年前去世', '信件邮戳来自邻市'],
    timelineEvents: [{ event: '周衍登门询问' }, { event: '' }],
    openThreads: ['红雨衣女子是谁', '信是谁寄出的'],
    closedThreads: ['钟为什么停在三点十七分'],
    arcSummary: '来信弧总结',
  });
  const after = applyBibleDelta(before, delta, 3, doc, 'a1');

  it('does not mutate the input', () => {
    expect(before).toEqual(makeBible());
  });
  it('updates characters keyed by doc id via alias, merges relationships, keeps untouched fields', () => {
    const c1 = after.characters['c1']!;
    expect(c1.state).toBe('决定追查');
    expect(c1.location).toBe('警局');
    expect(c1.knowledge).toBe('知道信是妻子字迹');
    expect(c1.relationships).toEqual(['与周衍互不信任', '开始信任周衍']);
    expect(c1.name).toBe('沈默');
  });
  it('matches bible-only entries by name and creates fallback keys for unknown names', () => {
    expect(after.characters['阿四']!.knowledge).toBe('看见寄信人');
    const nc = after.characters['陌生女子']!;
    expect(nc.state).toBe('出现在巷口'); // characterUpdates applied after newCharacters
    expect(Object.keys(after.characters)).toHaveLength(4);
    expect(after.characters['c1']!.state).not.toContain('不应覆盖');
  });
  it('appends timeline events with chapterNo, dedupes facts, moves threads', () => {
    expect(after.timeline.slice(-1)).toEqual([{ chapterNo: 3, event: '周衍登门询问' }]);
    expect(after.timeline).toHaveLength(4);
    expect(after.facts).toEqual(['钟表铺位于老城区', '林晚三年前去世', '信件邮戳来自邻市']);
    expect(after.openThreads).toEqual(['信是谁寄出的', '红雨衣女子是谁']);
  });
  it('stores the arc summary only when an arc id is given', () => {
    expect(after.arcSummaries).toEqual({ a1: '来信弧总结' });
    expect(applyBibleDelta(before, delta, 3, doc, null).arcSummaries).toEqual({});
  });
  it('caps timeline and facts', () => {
    const big = { ...makeBible(), timeline: Array.from({ length: 5000 }, (_, i) => ({ chapterNo: 1, event: `e${i}` })), facts: Array.from({ length: 1000 }, (_, i) => `f${i}`) };
    const out = applyBibleDelta(big, delta, 9, doc, null);
    expect(out.timeline).toHaveLength(5000);
    expect(out.timeline.at(-1)!.chapterNo).toBe(9);
    expect(out.facts).toHaveLength(1000);
    expect(out.facts.at(-1)).toBe('信件邮戳来自邻市');
  });
});

describe('bibleAppearances', () => {
  it('maps chapters to character ids via names/aliases (with doc) and bible keys (without)', () => {
    const bible = makeBible();
    const withDoc = bibleAppearances(bible, 2, makeDoc());
    expect(withDoc.get(1)).toEqual(new Set(['c1', 'c2']));
    expect(withDoc.get(2)).toEqual(new Set(['阿四']));
    const withoutDoc = bibleAppearances(bible, 1);
    expect(withoutDoc.get(1)).toEqual(new Set(['c1']));
    expect(withoutDoc.has(2)).toBe(false);
  });
  it('respects uptoChapterNo', () => {
    expect(bibleAppearances(makeBible(), 0).size).toBe(0);
  });
});
