import { PlannedThreadSchema } from './threadPlanning';
import { GENRE_PACK_IDS } from './genrePacks';
/**
 * Novel-workshop domain types: user requirements, chapter context and the zod
 * schemas for every structured LLM output (outline, chapter table, summary,
 * rewrite instructions). Pure module — no Tauri, no DB.
 */
import { z } from 'zod';
import {
  SettingKind, WritingBriefSchema,
  emptyLore,
  emptyVoice,
  type Arc,
  type Beat,
  type ChapterPlan,
  type Character,
  type Setting,
  type StorylineDoc,
} from '@the-water/shared';

// ---------------------------------------------------------------------------
// User requirements
// ---------------------------------------------------------------------------

export type NovelPov = '第一人称' | '第三人称有限' | '第三人称全知' | string;

export interface NovelRequirements {
  genre: string;
  style: string;
  pov: NovelPov;
  tense: string;
  tone: string;
  audience: string;
  taboos: string[];
  mustHave: string[];
  language: string;
  extra: string;
  /** 文章类型（docs/writing/README.md §3）；缺省为长篇小说。 */
  docType: string;
  /** 题材包 id（docs/writing/README.md §3.1，novel/genrePacks.ts）；可多选。留空时从 genre 推断。 */
  genrePackIds: string[];
  /** 关掉的题材层 lore 条目 id；作品层显式覆盖题材层用。 */
  disabledLore: string[];
}

export const defaultRequirements = (): NovelRequirements => ({
  genre: '',
  style: '',
  pov: '第三人称有限',
  tense: '过去时',
  tone: '',
  audience: '',
  taboos: [],
  mustHave: [],
  language: '简体中文',
  extra: '',
  docType: 'long-webnovel',
  genrePackIds: [],
  disabledLore: [],
});

const reqStr = (def = '') => z.string().max(2000).default(def);
const reqList = () => z.array(z.string().max(2000)).max(50).default([]);

export const NovelRequirementsSchema = z.object({
  genre: reqStr(),
  style: reqStr(),
  pov: reqStr('第三人称有限'),
  tense: reqStr('过去时'),
  tone: reqStr(),
  audience: reqStr(),
  taboos: reqList(),
  mustHave: reqList(),
  language: reqStr('简体中文'),
  extra: reqStr(),
  docType: z.string().max(40).default('long-webnovel'),
  genrePackIds: z.array(z.string().max(40)).max(GENRE_PACK_IDS.length).default([]),
  disabledLore: z.array(z.string().max(80)).max(100).default([]),
});

// ---------------------------------------------------------------------------
// Chapter context handed to the writing step
// ---------------------------------------------------------------------------

export interface ChapterContext {
  chapterNo: number;
  title: string;
  goal: string;
  targetChars: number;
  povCharacterName: string | null;
  beats: Beat[];
  endHook: string;
}

// ---------------------------------------------------------------------------
// LLM output schemas. `.default()` / `.catch()` are used liberally so that
// slightly sloppy model output still parses.
// ---------------------------------------------------------------------------

const LONG = 4000;
const text = (max = LONG) => z.string().max(max).default('');
const nameList = (itemMax = 80) => z.array(z.string().max(itemMax)).max(50).default([]);

export const OutlineSettingSchema = z.object({
  name: z.string().min(1).max(80),
  kind: SettingKind.catch('other'),
  description: text(),
});
export type OutlineSetting = z.infer<typeof OutlineSettingSchema>;

export const OutlineRelationshipSchema = z.object({
  targetName: z.string().max(80).default(''),
  kind: text(50),
  note: text(500),
});

export const OutlineCharacterSchema = z.object({
  name: z.string().min(1).max(50),
  aliases: z.array(z.string().max(50)).max(20).default([]),
  role: text(50),
  description: text(),
  arc: text(),
  relationships: z.array(OutlineRelationshipSchema).max(50).default([]),
});
export type OutlineCharacter = z.infer<typeof OutlineCharacterSchema>;

export const OutlineArcSchema = z.object({
  title: z.string().min(1).max(100),
  summary: text(),
  startChapterNo: z.number().int().min(1),
  endChapterNo: z.number().int().min(1),
});
export type OutlineArc = z.infer<typeof OutlineArcSchema>;

export const OutlineBeatSchema = z.object({
  /** 0-based index into `arcs`. */
  arcIndex: z.number().int().min(0),
  title: z.string().min(1).max(100),
  summary: text(),
  characterNames: nameList(50),
  settingNames: nameList(80),
  suggestedChapterNo: z.number().int().min(1).nullable().catch(null),
});
export type OutlineBeat = z.infer<typeof OutlineBeatSchema>;

export const OutlineDocSchema = z.object({
  writing: z.object({brief:WritingBriefSchema.extend({premise:z.string().trim().min(1,'创作简报缺少故事前提'),mainline:z.string().trim().min(1,'创作简报缺少全书主线')}),volumes:z.array(z.object({title:text(),summary:text(),startChapterNo:z.number().int().min(1).max(500),endChapterNo:z.number().int().min(1).max(500),arcIndexes:z.array(z.number().int().min(0))})).max(100),intents:z.array(z.object({characterName:text(),goal:text(),motivation:text(),contradiction:text(),fear:text().optional(),belief:text().optional(),habitualStrategy:text().optional(),independentAgenda:text().optional(),growth:z.array(z.object({chapterNo:z.number().int().min(1).max(500),change:text()}))})).max(500),threads:z.array(PlannedThreadSchema).max(30).optional()}).optional(),
  title: text(100),
  logline: z.string().trim().min(1, '大纲缺少全书主线，请重新生成').max(1000),
  themes: z.array(z.string().max(100)).max(20).default([]),
  settings: z.array(OutlineSettingSchema).max(500).default([]),
  characters: z.array(OutlineCharacterSchema).max(500).default([]),
  arcs: z.array(OutlineArcSchema).min(1, 'arcs 是空数组，必须补全故事弧').max(200),
  beats: z.array(OutlineBeatSchema).max(5000).default([]),
}).superRefine((outline, ctx) => {
  const count = outline.arcs.length;
  const allowed = count ? `合法下标为 0–${count - 1}` : 'arcs 是空数组，必须先补全实际故事弧';
  outline.writing?.volumes.forEach((volume, vi) => {
    if (volume.startChapterNo > volume.endChapterNo) ctx.addIssue({ code: 'custom', path: ['writing', 'volumes', vi, 'endChapterNo'], message: '分卷结束章不能早于开始章' });
    volume.arcIndexes.forEach((index, ii) => {
      if (index >= count) ctx.addIssue({ code: 'custom', path: ['writing', 'volumes', vi, 'arcIndexes', ii], message: `分卷「${volume.title}」引用不存在的故事弧下标 ${index}；${allowed}。arcIndexes 使用从 0 开始的 arcs 数组下标，分卷不能代替 arcs。` });
    });
  });
  outline.beats.forEach((beat, bi) => {
    if (beat.arcIndex >= count) ctx.addIssue({ code: 'custom', path: ['beats', bi, 'arcIndex'], message: `情节点「${beat.title}」引用不存在的故事弧下标 ${beat.arcIndex}；${allowed}` });
  });
  outline.writing?.intents.forEach((intent, ii) => {
    if (!outline.characters.some(c => c.name === intent.characterName || c.aliases.includes(intent.characterName))) ctx.addIssue({ code: 'custom', path: ['writing', 'intents', ii, 'characterName'], message: `人物动机引用不存在的人物「${intent.characterName}」，必须使用 characters 中的人物姓名或别名` });
  });
});
export type OutlineDoc = z.infer<typeof OutlineDocSchema>;

export const ChapterTableEntrySchema = z.object({
  chapterNo: z.number().int().min(1),
  title: text(100),
  goal: text(),
  beatTitles: z.array(z.string().max(100)).max(50).default([]),
  povCharacter: z.string().max(50).nullable().catch(null),
  targetChars: z.number().int().min(0).catch(0),
  endHook: text(1000),
});
export type ChapterTableEntry = z.infer<typeof ChapterTableEntrySchema>;
export const ChapterTableSchema = z.array(ChapterTableEntrySchema).max(500);
export type ChapterTable = z.infer<typeof ChapterTableSchema>;

export const CharacterUpdateSchema = z.object({
  name: z.string().min(1).max(50),
  state: text(2000),
  location: text(200),
  knowledge: text(2000),
  relationshipChanges: z.array(z.string().max(300)).max(50).default([]),
});

export const BibleDeltaSchema = z.object({
  characterUpdates: z.array(CharacterUpdateSchema).max(100).default([]),
  newCharacters: z
    .array(z.object({ name: z.string().min(1).max(50), role: text(50), description: text(2000) }))
    .max(50)
    .default([]),
  newFacts: z.array(z.string().max(500)).max(100).default([]),
  timelineEvents: z.array(z.object({ event: z.string().max(500) })).max(100).default([]),
  openThreads: z.array(z.string().max(500)).max(100).default([]),
  closedThreads: z.array(z.string().max(500)).max(100).default([]),
  arcSummary: z.string().max(LONG).nullable().catch(null),
});
export type BibleDelta = z.infer<typeof BibleDeltaSchema>;

export const SummarizeResultSchema = z.object({
  summary: z.string().max(600),
  bibleDelta: BibleDeltaSchema.default({
    characterUpdates: [],
    newCharacters: [],
    newFacts: [],
    timelineEvents: [],
    openThreads: [],
    closedThreads: [],
    arcSummary: null,
  }),
  continuityWarnings: z.array(z.string().max(500)).max(50).default([]),
});
export type SummarizeResult = z.infer<typeof SummarizeResultSchema>;

export const RewriteInstructionsSchema = z.array(
  z.object({
    chapterNo: z.number().int().min(1),
    instructions: z.array(z.string().max(1000)).max(30).default([]),
  }),
);
export type RewriteInstructions = z.infer<typeof RewriteInstructionsSchema>;

// ---------------------------------------------------------------------------
// OutlineDoc + ChapterTable → StorylineDoc (names → ids)
// ---------------------------------------------------------------------------

const norm = (s: string): string => s.trim().toLowerCase();

/** Fuzzy title match: exact first, then substring containment either way. */
export function matchBeatByTitle<T extends { title: string }>(title: string, beats: readonly T[]): T | undefined {
  const q = norm(title);
  if (!q) return undefined;
  const exact = beats.find((b) => norm(b.title) === q);
  if (exact) return exact;
  return beats.find((b) => {
    const t = norm(b.title);
    return t.length > 0 && (t.includes(q) || q.includes(t));
  });
}

export function toStorylineDoc(
  outline: OutlineDoc,
  premise: string,
  chapterTable: ChapterTable,
  makeId: () => string,
): StorylineDoc {
  // Characters: id per entry, lookup by name and every alias.
  const charByName = new Map<string, string>();
  const characters: Character[] = outline.characters.map((c) => {
    const id = makeId();
    const name = c.name.trim();
    if (!charByName.has(norm(name))) charByName.set(norm(name), id);
    for (const a of c.aliases) {
      const k = norm(a);
      if (k && !charByName.has(k)) charByName.set(k, id);
    }
    return { id, name, aliases: c.aliases.map((a) => a.trim()).filter(Boolean), role: c.role, description: c.description, arc: c.arc, relationships: [], ...emptyVoice() };
  });
  const resolveChar = (name: string | null | undefined): string | null => {
    if (!name) return null;
    return charByName.get(norm(name)) ?? null;
  };
  outline.characters.forEach((c, i) => {
    const target = characters[i]!;
    target.relationships = c.relationships.flatMap((r) => {
      const targetId = resolveChar(r.targetName);
      if (!targetId || targetId === target.id) return [];
      return [{ targetId, kind: r.kind, note: r.note }];
    });
  });

  // Settings.
  const settingByName = new Map<string, string>();
  const settings: Setting[] = outline.settings.map((s) => {
    const id = makeId();
    const name = s.name.trim();
    if (!settingByName.has(norm(name))) settingByName.set(norm(name), id);
    return { id, name, kind: s.kind, description: s.description, ...emptyLore() };
  });
  const resolveSetting = (name: string): string | null => settingByName.get(norm(name)) ?? null;

  // Arcs.
  const arcs: Arc[] = outline.arcs.map((a) => ({
    id: makeId(),
    title: a.title.trim(),
    summary: a.summary,
    startChapterNo: a.startChapterNo,
    endChapterNo: Math.max(a.startChapterNo, a.endChapterNo),
  }));

  // Beats.
  const beats: Beat[] = outline.beats.map((b, order) => ({
    id: makeId(),
    arcId: arcs[b.arcIndex]?.id ?? null,
    title: b.title.trim(),
    summary: b.summary,
    chapterNo: b.suggestedChapterNo,
    characterIds: uniq(b.characterNames.map(resolveChar).filter((x): x is string => x !== null)),
    settingIds: uniq(b.settingNames.map(resolveSetting).filter((x): x is string => x !== null)),
    order,
  }));

  // Chapters from the table; beats attached by (fuzzy) title.
  const chapters: ChapterPlan[] = [...chapterTable]
    .sort((a, b) => a.chapterNo - b.chapterNo)
    .map((row) => {
      const beatIds = uniq(
        row.beatTitles
          .map((t) => matchBeatByTitle(t, beats))
          .filter((b): b is Beat => b !== undefined)
          .map((b) => b.id),
      );
      for (const id of beatIds) {
        const beat = beats.find((b) => b.id === id)!;
        if (beat.chapterNo === null) beat.chapterNo = row.chapterNo;
      }
      return {
        chapterNo: row.chapterNo,
        title: row.title.trim(),
        goal: row.goal,
        beatIds,
        povCharacterId: resolveChar(row.povCharacter),
        targetChars: Math.max(0, Math.round(row.targetChars)),
        endHook: row.endHook,
      };
    });

  return {
    version: 1,
    premise,
    themes: outline.themes.map((t) => t.trim()).filter(Boolean),
    characters,
    settings,
    arcs,
    beats,
    chapters,
    styleProfile: null,
    derivative: null,
  };
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
