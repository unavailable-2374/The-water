import { describe, expect, it } from 'vitest';
import {
  ChapterTableSchema,
  NovelRequirementsSchema,
  OutlineDocSchema,
  SummarizeResultSchema,
  RewriteInstructionsSchema,
  defaultRequirements,
  matchBeatByTitle,
  toStorylineDoc,
  type OutlineDoc,
} from '@/novel/types';
import { StorylineDocSchema } from '@the-water/shared';

const outline: OutlineDoc = OutlineDocSchema.parse({
  title: '钟停',
  logline: '钟表匠追寻亡妻来信的真相。',
  themes: ['记忆'],
  settings: [
    { name: '钟表铺', kind: 'location', description: '老城区' },
    { name: '雨城', kind: 'city', description: '常年阴雨' }, // sloppy kind → other
  ],
  characters: [
    { name: '沈默', aliases: ['老沈'], role: '主角', relationships: [{ targetName: '林晚', kind: '妻子' }, { targetName: '不存在的人', kind: '朋友' }] },
    { name: '林晚', role: '妻子' },
    { name: '周衍', aliases: ['周警官'], relationships: [{ targetName: '老沈', kind: '怀疑对象' }] },
  ],
  arcs: [
    { title: '来信', startChapterNo: 1, endChapterNo: 2 },
    { title: '真相', startChapterNo: 3, endChapterNo: 4 },
  ],
  beats: [
    { arcIndex: 0, title: '雨夜来信', characterNames: ['沈默'], settingNames: ['钟表铺'], suggestedChapterNo: 1 },
    { arcIndex: 0, title: '钟停了', characterNames: ['老沈'], settingNames: ['未知地点'] },
    { arcIndex: 1, title: '警官登门', characterNames: ['周警官', '沈默'], suggestedChapterNo: 3 },
    { arcIndex: 1, title: '真相大白', characterNames: ['林晚'], suggestedChapterNo: 4 },
  ],
});

describe('schemas', () => {
  it('OutlineDocSchema fills defaults and tolerates sloppy values', () => {
    expect(outline.settings[1]!.kind).toBe('other');
    expect(outline.characters[1]!.aliases).toEqual([]);
    expect(outline.beats[1]!.suggestedChapterNo).toBeNull();
    expect(outline.beats[3]!.arcIndex).toBe(1);
    expect(OutlineDocSchema.safeParse({}).success).toBe(false);
    expect(OutlineDocSchema.parse({ logline: 'TEST supplied story logline', arcs: [{ title: 'TEST arc', startChapterNo: 1, endChapterNo: 5 }] }).characters).toEqual([]);
  });
  it('ChapterTableSchema parses minimal rows', () => {
    const rows = ChapterTableSchema.parse([{ chapterNo: 1, targetChars: 'abc' }, { chapterNo: 2, povCharacter: 3 }]);
    expect(rows[0]!.targetChars).toBe(0);
    expect(rows[0]!.beatTitles).toEqual([]);
    expect(rows[1]!.povCharacter).toBeNull();
  });
  it('SummarizeResultSchema requires summary and defaults the rest', () => {
    const r = SummarizeResultSchema.parse({ summary: '摘要', bibleDelta: { newFacts: ['x'], arcSummary: 5 } });
    expect(r.bibleDelta.newFacts).toEqual(['x']);
    expect(r.bibleDelta.arcSummary).toBeNull();
    expect(r.bibleDelta.characterUpdates).toEqual([]);
    expect(r.continuityWarnings).toEqual([]);
    expect(SummarizeResultSchema.safeParse({}).success).toBe(false);
    expect(SummarizeResultSchema.safeParse({ summary: '字'.repeat(601) }).success).toBe(false);
  });
  it('RewriteInstructionsSchema & NovelRequirementsSchema', () => {
    expect(RewriteInstructionsSchema.parse([{ chapterNo: 2 }])[0]!.instructions).toEqual([]);
    expect(NovelRequirementsSchema.parse({})).toEqual(defaultRequirements());
    expect(NovelRequirementsSchema.safeParse({ taboos: Array.from({ length: 51 }, () => 'x') }).success).toBe(false);
  });
});

describe('matchBeatByTitle', () => {
  const beats = [{ title: '雨夜来信' }, { title: '钟停了' }, { title: '警官登门' }];
  it('exact first, then containment either direction', () => {
    expect(matchBeatByTitle('钟停了', beats)?.title).toBe('钟停了');
    expect(matchBeatByTitle('钟停了。', beats)?.title).toBe('钟停了');
    expect(matchBeatByTitle('登门', beats)?.title).toBe('警官登门');
    expect(matchBeatByTitle('毫无关联', beats)).toBeUndefined();
    expect(matchBeatByTitle('', beats)).toBeUndefined();
  });
});

describe('toStorylineDoc', () => {
  let n = 0;
  const makeId = () => `id${++n}`;
  const table = ChapterTableSchema.parse([
    { chapterNo: 2, title: '钟', goal: 'g2', beatTitles: ['钟停了'], povCharacter: '老沈', targetChars: 2800, endHook: 'h2' },
    { chapterNo: 1, title: '信', goal: 'g1', beatTitles: ['雨夜来信', '不存在的情节'], povCharacter: '沈默', targetChars: 3200, endHook: 'h1' },
    { chapterNo: 3, title: '客', goal: 'g3', beatTitles: ['登门'], povCharacter: '无名氏', targetChars: 3000, endHook: '' },
    { chapterNo: 4, title: '真', goal: 'g4', beatTitles: ['真相'], povCharacter: null, targetChars: 3000, endHook: '' },
  ]);
  const doc = toStorylineDoc(outline, '前提', table, makeId);

  it('produces a valid StorylineDoc', () => {
    expect(StorylineDocSchema.safeParse(doc).success).toBe(true);
    expect(doc.premise).toBe('前提');
    expect(doc.themes).toEqual(['记忆']);
    expect(doc.chapters.map((c) => c.chapterNo)).toEqual([1, 2, 3, 4]);
  });

  it('resolves character names and aliases to ids; drops unknown targets', () => {
    const shen = doc.characters.find((c) => c.name === '沈默')!;
    const lin = doc.characters.find((c) => c.name === '林晚')!;
    const zhou = doc.characters.find((c) => c.name === '周衍')!;
    expect(shen.relationships).toEqual([{ targetId: lin.id, kind: '妻子', note: '' }]);
    expect(zhou.relationships[0]!.targetId).toBe(shen.id);
    expect(doc.chapters[0]!.povCharacterId).toBe(shen.id);
    expect(doc.chapters[1]!.povCharacterId).toBe(shen.id); // via alias 老沈
    expect(doc.chapters[2]!.povCharacterId).toBeNull(); // unknown name
  });

  it('attaches beats to arcs by arcIndex and resolves entity ids', () => {
    const [b1, b2, b3, b4] = doc.beats;
    expect(b1!.arcId).toBe(doc.arcs[0]!.id);
    expect(b3!.arcId).toBe(doc.arcs[1]!.id);
    expect(b4!.arcId).toBe(doc.arcs[1]!.id);
    expect(b1!.settingIds).toEqual([doc.settings[0]!.id]);
    expect(b2!.settingIds).toEqual([]); // unknown setting dropped
    expect(b3!.characterIds).toHaveLength(2);
    expect(doc.beats.map((b) => b.order)).toEqual([0, 1, 2, 3]);
  });

  it('resolves beatTitles exactly then fuzzily and back-fills beat.chapterNo', () => {
    expect(doc.chapters[0]!.beatIds).toEqual([doc.beats[0]!.id]);
    expect(doc.chapters[1]!.beatIds).toEqual([doc.beats[1]!.id]);
    expect(doc.chapters[2]!.beatIds).toEqual([doc.beats[2]!.id]); // '登门' ⊂ '警官登门'
    expect(doc.chapters[3]!.beatIds).toEqual([doc.beats[3]!.id]); // '真相' ⊂ '真相大白'
    expect(doc.beats[1]!.chapterNo).toBe(2); // was null in outline
    expect(doc.chapters[0]!.targetChars).toBe(3200);
  });
});
