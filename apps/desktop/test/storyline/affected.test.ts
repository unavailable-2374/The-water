import { describe, expect, it } from 'vitest';
import type { StorylineDoc } from '@the-water/shared';
import { diffStoryline } from '@/novel/storyline/diff';
import {
  applyNameReplacements,
  buildRewritePlan,
  computeAffectedChapters,
  deriveAppearances,
  type AffectedChapter,
} from '@/novel/storyline/affected';
import { makeDoc } from '../fixtures/storyline';

const allWritten = new Set([1, 2, 3, 4]);

function affected(before: StorylineDoc, after: StorylineDoc, written: Set<number> = allWritten, appearances?: Map<number, Set<string>>): AffectedChapter[] {
  return computeAffectedChapters({ diff: diffStoryline(before, after), before, after, writtenChapterNos: written, appearances });
}
const byNo = (xs: AffectedChapter[]): Record<number, AffectedChapter> => Object.fromEntries(xs.map((x) => [x.chapterNo, x]));
const codes = (x: AffectedChapter | undefined): string[] => (x ? x.reasons.map((r) => r.code) : []);

describe('deriveAppearances', () => {
  it('unions beat characters/settings and POV per chapter, resolving beat chapter via beatIds', () => {
    const doc = makeDoc();
    doc.beats[2] = { ...doc.beats[2]!, chapterNo: null }; // b3 only reachable through chapter 3 beatIds
    const app = deriveAppearances(doc);
    expect([...app.get(1)!].sort()).toEqual(['c1', 's1']);
    expect([...app.get(3)!].sort()).toEqual(['c1', 'c3', 's1']);
    expect([...app.get(4)!].sort()).toEqual(['c1', 'c2', 'c3', 's2']);
  });
});

describe('computeAffectedChapters', () => {
  it('returns nothing when the diff is empty', () => {
    expect(affected(makeDoc(), makeDoc())).toEqual([]);
  });

  it('name-only change → name_replace on appearing chapters, no ripple', () => {
    const before = makeDoc();
    const after = makeDoc();
    after.characters[2] = { ...after.characters[2]!, name: '周衍之', aliases: ['周队长'] };
    const res = affected(before, after);
    expect(res.map((r) => r.chapterNo)).toEqual([3, 4]);
    for (const r of res) {
      expect(r.mode).toBe('name_replace');
      expect(r.stale).toBe(false);
      expect(codes(r)).toEqual(['character_renamed']);
      expect(r.nameReplacements).toEqual([
        { from: '周衍', to: '周衍之' },
        { from: '周警官', to: '周队长' },
      ]);
      expect(r.reasons[0]!.text).toContain('周衍之');
    }
  });

  it('alias removed without a replacement maps to the new name', () => {
    const before = makeDoc();
    const after = makeDoc();
    after.characters[0] = { ...after.characters[0]!, aliases: [] };
    const res = affected(before, after);
    expect(res.every((r) => r.mode === 'name_replace')).toBe(true);
    expect(res[0]!.nameReplacements).toEqual([{ from: '老沈', to: '沈默' }]);
  });

  it('POV character description change → rewrite on POV chapters, revise elsewhere it appears', () => {
    const before = makeDoc();
    const after = makeDoc();
    after.characters[2] = { ...after.characters[2]!, description: '其实是林晚的弟弟' }; // c3 is POV of ch3, appears in ch4
    const res = byNo(affected(before, after));
    expect(Object.keys(res).map(Number)).toEqual([3, 4]);
    expect(res[3]!.mode).toBe('rewrite');
    expect(codes(res[3])).toEqual(expect.arrayContaining(['character_changed', 'pov_changed']));
    expect(res[4]!.mode).toBe('revise');
    expect(res[4]!.stale).toBe(false);
    expect(codes(res[4])).toEqual(['character_changed']);
    expect(res[4]!.reasons[0]!.text).toContain('周衍');
  });

  it('non-POV character arc change → revise on appearing chapters only', () => {
    const before = makeDoc();
    const after = makeDoc();
    after.characters[1] = { ...after.characters[1]!, arc: '从缺席到在场' }; // c2 only in ch4 beat
    const res = affected(before, after);
    expect(res).toEqual([expect.objectContaining({ chapterNo: 4, mode: 'revise', stale: false })]);
  });

  it('beat moved → both old and new chapters rewrite, ripple after the earliest', () => {
    const before = makeDoc();
    const after = makeDoc();
    after.beats[1] = { ...after.beats[1]!, chapterNo: 4 }; // b2: ch2 → ch4
    after.chapters[1] = { ...after.chapters[1]!, beatIds: [] };
    after.chapters[3] = { ...after.chapters[3]!, beatIds: ['b4', 'b2'] };
    const res = byNo(affected(before, after));
    expect(res[2]!.mode).toBe('rewrite');
    expect(codes(res[2])).toContain('beat_moved');
    expect(res[4]!.mode).toBe('rewrite');
    expect(codes(res[4])).toContain('beat_moved');
    expect(res[2]!.reasons.find((r) => r.code === 'beat_moved')!.text).toBe('节拍「钟停了」从第2章移至第4章');
    expect(res[3]).toEqual({ chapterNo: 3, mode: 'revise', stale: true, reasons: [{ code: 'continuity', text: '前文已重写，可能影响连贯性' }] });
    expect(res[1]).toBeUndefined();
  });

  it('beat content change / added / removed → rewrite on its chapter', () => {
    const before = makeDoc();
    const after = makeDoc();
    after.beats[0] = { ...after.beats[0]!, summary: '沈默收到两封信' };
    after.beats = after.beats.filter((b) => b.id !== 'b3');
    after.beats.push({ id: 'b9', arcId: 'a2', title: '尾声', summary: '', chapterNo: null, characterIds: [], settingIds: [], order: 9 });
    after.chapters[3] = { ...after.chapters[3]!, beatIds: ['b4', 'b9'] };
    const res = byNo(affected(before, after));
    expect(codes(res[1])).toEqual(['beat_changed']);
    expect(codes(res[3])).toContain('beat_removed');
    expect(codes(res[4])).toEqual(expect.arrayContaining(['chapter_plan', 'beat_added']));
    expect([1, 3, 4].every((n) => res[n]!.mode === 'rewrite')).toBe(true);
    expect(res[2]!.stale).toBe(true);
  });

  it('removed character → rewrite on appearing chapters (entity_removed)', () => {
    const before = makeDoc();
    const after = makeDoc();
    after.characters = after.characters.filter((c) => c.id !== 'c2');
    const res = affected(before, after);
    expect(res).toEqual([expect.objectContaining({ chapterNo: 4, mode: 'rewrite', stale: false })]);
    expect(res[0]!.reasons).toEqual([{ code: 'entity_removed', text: '人物「林晚」已删除' }]);
  });

  it('setting change → revise on referencing chapters', () => {
    const before = makeDoc();
    const after = makeDoc();
    after.settings[0] = { ...after.settings[0]!, description: '搬到新城区' }; // s1 in ch1, ch3
    const res = affected(before, after);
    expect(res.map((r) => [r.chapterNo, r.mode])).toEqual([
      [1, 'revise'],
      [3, 'revise'],
    ]);
    expect(codes(res[0])).toEqual(['setting_changed']);
  });

  it('arc summary change → revise over its range; range change → symmetric difference', () => {
    const before = makeDoc();
    const after = makeDoc();
    after.arcs[0] = { ...after.arcs[0]!, summary: '新摘要' };
    let res = affected(before, after);
    expect(res.map((r) => [r.chapterNo, r.mode, r.stale])).toEqual([
      [1, 'revise', false],
      [2, 'revise', false],
    ]);
    expect(codes(res[0])).toEqual(['arc_changed']);

    const after2 = makeDoc();
    after2.arcs[0] = { ...after2.arcs[0]!, endChapterNo: 3 };
    res = affected(before, after2);
    expect(res.map((r) => r.chapterNo)).toEqual([3]);
    expect(res[0]!.reasons[0]!.text).toContain('1-2 改为 1-3');
  });

  it('chapter plan: goal/beatIds/pov → rewrite, title/endHook/targetChars → revise', () => {
    const before = makeDoc();
    const after = makeDoc();
    after.chapters[0] = { ...after.chapters[0]!, title: '来信', targetChars: 4000 };
    after.chapters[2] = { ...after.chapters[2]!, povCharacterId: 'c1' };
    const res = byNo(affected(before, after));
    expect(res[1]!.mode).toBe('revise');
    expect(codes(res[1])).toEqual(['chapter_plan']);
    expect(res[3]!.mode).toBe('rewrite');
    expect(codes(res[3])).toEqual(['pov_changed']);
    expect(res[4]!.stale).toBe(true);
    expect(res[2]).toBeUndefined();
  });

  it('excludes unwritten chapters from affected and ripple', () => {
    const before = makeDoc();
    const after = makeDoc();
    after.chapters[0] = { ...after.chapters[0]!, goal: '新目标' };
    const res = affected(before, after, new Set([1, 3]));
    expect(res.map((r) => [r.chapterNo, r.mode, r.stale])).toEqual([
      [1, 'rewrite', false],
      [3, 'revise', true],
    ]);
    expect(affected(before, after, new Set([2]))).toEqual([]);
  });

  it('uses provided appearances in addition to derived ones', () => {
    const before = makeDoc();
    const after = makeDoc();
    after.characters[1] = { ...after.characters[1]!, name: '林晚晚' }; // c2 in beats only in ch4
    const res = affected(before, after, allWritten, new Map([[1, new Set(['c2'])]]));
    expect(res.map((r) => r.chapterNo)).toEqual([1, 4]);
  });

  it('dedupes reasons and takes the strongest mode', () => {
    const before = makeDoc();
    const after = makeDoc();
    after.characters[2] = { ...after.characters[2]!, name: '周衍之', description: '换了描述' };
    const res = byNo(affected(before, after));
    expect(res[3]!.mode).toBe('rewrite');
    expect(res[3]!.nameReplacements).toEqual([{ from: '周衍', to: '周衍之' }]);
    expect(res[4]!.mode).toBe('revise');
    expect(new Set(codes(res[4]))).toEqual(new Set(['character_renamed', 'character_changed']));
    expect(res[4]!.reasons).toHaveLength(2);
  });
});

describe('buildRewritePlan', () => {
  const before = makeDoc();
  const after = makeDoc();
  after.beats[0] = { ...after.beats[0]!, summary: '改' };
  after.characters[1] = { ...after.characters[1]!, name: '林晚晚' };
  const aff = affected(before, after);

  it('selects directly affected items and leaves stale ones unselected by default', () => {
    const plan = buildRewritePlan(aff);
    expect(plan.map((p) => [p.chapterNo, p.mode, p.selected, p.stale])).toEqual([
      [1, 'rewrite', true, false],
      [2, 'revise', false, true],
      [3, 'revise', false, true],
      [4, 'name_replace', true, false],
    ]);
    expect(plan[3]!.nameReplacements).toEqual([{ from: '林晚', to: '林晚晚' }]);
    expect(plan[0]!.nameReplacements).toBeUndefined();
  });

  it('selects stale items when includeContinuity is set', () => {
    const plan = buildRewritePlan(aff, { includeContinuity: true });
    expect(plan.every((p) => p.selected)).toBe(true);
  });
});

describe('applyNameReplacements', () => {
  it('replaces longest match first so 林晚晚 is not mangled by 林晚', () => {
    const out = applyNameReplacements('林晚晚和林晚是两个人，林晚晚先到。', [
      { from: '林晚', to: '苏晚' },
      { from: '林晚晚', to: '阿晚' },
    ]);
    expect(out).toBe('阿晚和苏晚是两个人，阿晚先到。');
  });

  it('does not chain replacements or touch text introduced by another replacement', () => {
    expect(applyNameReplacements('甲遇见乙', [{ from: '甲', to: '乙' }, { from: '乙', to: '丙' }])).toBe('乙遇见丙');
  });

  it('skips empty and identity pairs and escapes regex metacharacters', () => {
    expect(applyNameReplacements('老沈(沈默)', [{ from: '', to: 'x' }, { from: '沈默', to: '沈默' }])).toBe('老沈(沈默)');
    expect(applyNameReplacements('老沈(沈默)', [{ from: '(沈默)', to: '' }])).toBe('老沈');
  });
});
