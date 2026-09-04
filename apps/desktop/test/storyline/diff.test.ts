import { describe, expect, it } from 'vitest';
import { emptyLore } from '@the-water/shared';
import { diffStoryline, summarizeDiff } from '@/novel/storyline/diff';
import { makeDoc } from '../fixtures/storyline';

describe('diffStoryline', () => {
  it('reports isEmpty for identical docs and does not mutate inputs', () => {
    const before = makeDoc();
    const after = makeDoc();
    const d = diffStoryline(before, after);
    expect(d.isEmpty).toBe(true);
    expect(d.premiseChanged).toBe(false);
    expect(d.themesChanged).toBe(false);
    expect(d.characters).toEqual({ added: [], removed: [], changed: [] });
    expect(d.beats.moved).toEqual([]);
    expect(d.chapters).toEqual([]);
    expect(before).toEqual(makeDoc());
    expect(after).toEqual(makeDoc());
  });

  it('treats aliases/characterIds/settingIds as unordered but beatIds as ordered', () => {
    const before = makeDoc();
    const after = makeDoc();
    after.characters[0]!.aliases = ['老沈'];
    after.beats[3]!.characterIds = ['c3', 'c1', 'c2'];
    after.themes = ['时间', '记忆'];
    expect(diffStoryline(before, after).isEmpty).toBe(true);

    after.chapters[3]!.beatIds = ['b4', 'b1'];
    before.chapters[3]!.beatIds = ['b1', 'b4'];
    const d = diffStoryline(before, after);
    expect(d.isEmpty).toBe(false);
    expect(d.chapters).toEqual([{ chapterNo: 4, fields: ['beatIds'] }]);
  });

  it('detects field-level character changes with before/after payloads', () => {
    const before = makeDoc();
    const after = makeDoc();
    after.characters[1] = { ...after.characters[1]!, name: '林晚晚', description: '生前是钟表铺的记账人' };
    const d = diffStoryline(before, after);
    expect(d.characters.changed).toHaveLength(1);
    const c = d.characters.changed[0]!;
    expect(c.id).toBe('c2');
    expect(c.fields.sort()).toEqual(['description', 'name']);
    expect((c.before as { name: string }).name).toBe('林晚');
    expect((c.after as { name: string }).name).toBe('林晚晚');
  });

  it('reports added/removed entities and premise/theme changes', () => {
    const before = makeDoc();
    const after = makeDoc();
    after.premise = '另一个前提';
    after.themes = ['记忆'];
    after.characters = after.characters.filter((c) => c.id !== 'c3');
    after.settings.push({ id: 's4', name: '警局', kind: 'location', description: '', ...emptyLore() });
    const d = diffStoryline(before, after);
    expect(d.premiseChanged).toBe(true);
    expect(d.themesChanged).toBe(true);
    expect(d.characters.removed.map((c) => c.id)).toEqual(['c3']);
    expect(d.settings.added.map((s) => s.id)).toEqual(['s4']);
  });

  it('marks moved beats in both changed (chapterNo) and moved', () => {
    const before = makeDoc();
    const after = makeDoc();
    after.beats[1] = { ...after.beats[1]!, chapterNo: 3 };
    const d = diffStoryline(before, after);
    expect(d.beats.changed).toEqual([expect.objectContaining({ id: 'b2', fields: ['chapterNo'] })]);
    expect(d.beats.moved).toEqual([{ id: 'b2', fromChapterNo: 2, toChapterNo: 3 }]);
  });

  it('reports added/removed chapter plans with sentinel fields, sorted by chapterNo', () => {
    const before = makeDoc();
    const after = makeDoc();
    after.chapters = after.chapters.filter((c) => c.chapterNo !== 2);
    after.chapters.push({ chapterNo: 5, title: '尾', goal: '', beatIds: [], povCharacterId: null, targetChars: 0, endHook: '' });
    after.chapters[0] = { ...after.chapters[0]!, title: '来信', endHook: '' };
    const d = diffStoryline(before, after);
    expect(d.chapters).toEqual([
      { chapterNo: 1, fields: expect.arrayContaining(['title', 'endHook']) },
      { chapterNo: 2, fields: ['removed'] },
      { chapterNo: 5, fields: ['added'] },
    ]);
  });

  it('detects arc summary and range changes', () => {
    const before = makeDoc();
    const after = makeDoc();
    after.arcs[0] = { ...after.arcs[0]!, summary: '改写后的弧摘要', endChapterNo: 3 };
    const d = diffStoryline(before, after);
    expect(d.arcs.changed[0]!.fields.sort()).toEqual(['endChapterNo', 'summary']);
  });
});

describe('summarizeDiff', () => {
  it('returns a placeholder for an empty diff', () => {
    expect(summarizeDiff(diffStoryline(makeDoc(), makeDoc()), makeDoc(), makeDoc())).toBe('（无变更）');
  });

  it('lists changes with resolved names as Chinese bullets', () => {
    const before = makeDoc();
    const after = makeDoc();
    after.premise = 'x';
    after.characters[1] = { ...after.characters[1]!, arc: '被遗忘到被记住', description: '记账人' };
    after.characters[2] = { ...after.characters[2]!, name: '周衍之' };
    after.characters = after.characters.filter((c) => c.id !== 'c1');
    after.settings[0] = { ...after.settings[0]!, description: '搬到了新城区' };
    after.arcs[1] = { ...after.arcs[1]!, summary: '新摘要', endChapterNo: 5 };
    after.beats[1] = { ...after.beats[1]!, chapterNo: 3, summary: '钟走了' };
    after.beats.push({ id: 'b5', arcId: 'a2', title: '尾声', summary: '', chapterNo: 4, characterIds: [], settingIds: [], order: 4 });
    after.chapters[0] = { ...after.chapters[0]!, goal: '新目标' };

    const s = summarizeDiff(diffStoryline(before, after), after, before);
    const lines = s.split('\n');
    expect(lines.every((l) => l.startsWith('- '))).toBe(true);
    expect(s).toContain('- 前提已修改');
    expect(s).toContain('- 删除人物「沈默」');
    expect(s).toMatch(/- 人物「林晚」：修改了 (arc、description|description、arc)/);
    expect(s).toContain('- 人物「周衍」→「周衍之」：修改了 name');
    expect(s).toContain('- 设定「钟表铺」：修改了 description');
    expect(s).toContain('故事弧「真相」');
    expect(s).toContain('3–4 → 3–5');
    expect(s).toContain('- 节拍「钟停了」：修改了 summary');
    expect(s).toContain('- 节拍「钟停了」从第2章移至第3章');
    expect(s).toContain('- 新增节拍「尾声」（第4章）');
    expect(s).toContain('- 第1章：修改了 goal');
  });
});
