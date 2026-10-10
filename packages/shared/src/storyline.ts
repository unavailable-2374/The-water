import { z } from 'zod';
import { DerivativeDeclSchema, StyleProfileSchema } from './style';

export const SettingKind = z.enum(['world', 'location', 'faction', 'item', 'rule', 'other']);
export type SettingKind = z.infer<typeof SettingKind>;

export const RelationshipSchema = z.object({
  targetId: z.string().max(64),
  kind: z.string().max(50),
  note: z.string().max(500).default(''),
});

export const CharacterSchema = z.object({
  id: z.string().max(64),
  name: z.string().min(1).max(50),
  aliases: z.array(z.string().max(50)).max(20).default([]),
  role: z.string().max(50).default(''),
  description: z.string().max(4000).default(''),
  arc: z.string().max(4000).default(''),
  relationships: z.array(RelationshipSchema).max(50).default([]),
  // ---- 言行规格（二创保味道的关键；docs/writing/templates/character-card.md）----
  /** ≥5 句原话样本，覆盖平静/愤怒/玩笑/撒谎/对亲近之人。 */
  speechSamples: z.array(z.string().max(300)).max(20).default([]),
  /** 口头禅、惯用句式。 */
  verbalTics: z.array(z.string().max(60)).max(20).default([]),
  /** 称呼表：self / 对某人 / 被谁称呼。键为说明，值为称呼。 */
  addressBook: z.record(z.string().max(40), z.string().max(40)).default({}),
  /** 绝不会做的事，OOC 检测直接引用。 */
  redlines: z.array(z.string().max(200)).max(20).default([]),
});
export type Character = z.infer<typeof CharacterSchema>;

export const SettingSchema = z.object({
  id: z.string().max(64),
  name: z.string().min(1).max(80),
  kind: SettingKind.default('other'),
  description: z.string().max(4000).default(''),
  // ---- lorebook 触发（docs/writing/templates/world-entry.md）----
  /** 任一命中即注入；为空则只按情节点引用注入。 */
  triggerKeys: z.array(z.string().max(40)).max(30).default([]),
  /** 0–100，高者先注入。 */
  priority: z.number().int().min(0).max(100).default(50),
  /** 常驻：每章必注。 */
  constant: z.boolean().default(false),
});
export type Setting = z.infer<typeof SettingSchema>;

export type CharacterVoice = Pick<Character, 'speechSamples' | 'verbalTics' | 'addressBook' | 'redlines'>;
export function emptyVoice(): CharacterVoice {
  return { speechSamples: [], verbalTics: [], addressBook: {}, redlines: [] };
}
export type SettingLore = Pick<Setting, 'triggerKeys' | 'priority' | 'constant'>;
export function emptyLore(): SettingLore {
  return { triggerKeys: [], priority: 50, constant: false };
}

export const ArcSchema = z.object({
  id: z.string().max(64),
  title: z.string().min(1).max(100),
  summary: z.string().max(4000).default(''),
  startChapterNo: z.number().int().min(1),
  endChapterNo: z.number().int().min(1),
});
export type Arc = z.infer<typeof ArcSchema>;

export const BeatSchema = z.object({
  id: z.string().max(64),
  arcId: z.string().max(64).nullable().default(null),
  title: z.string().min(1).max(100),
  summary: z.string().max(4000).default(''),
  chapterNo: z.number().int().min(1).nullable().default(null),
  characterIds: z.array(z.string().max(64)).max(50).default([]),
  settingIds: z.array(z.string().max(64)).max(50).default([]),
  order: z.number().int().default(0),
});
export type Beat = z.infer<typeof BeatSchema>;

export const ChapterPlanSchema = z.object({
  chapterNo: z.number().int().min(1),
  title: z.string().max(100).default(''),
  goal: z.string().max(4000).default(''),
  beatIds: z.array(z.string().max(64)).max(50).default([]),
  povCharacterId: z.string().max(64).nullable().default(null),
  targetChars: z.number().int().min(0).default(0),
  endHook: z.string().max(1000).default(''),
});
export type ChapterPlan = z.infer<typeof ChapterPlanSchema>;

export const StorylineDocSchema = z.object({
  version: z.literal(1),
  premise: z.string().max(20_000).default(''),
  themes: z.array(z.string().max(100)).max(20).default([]),
  characters: z.array(CharacterSchema).max(500).default([]),
  settings: z.array(SettingSchema).max(500).default([]),
  arcs: z.array(ArcSchema).max(200).default([]),
  beats: z.array(BeatSchema).max(5000).default([]),
  chapters: z.array(ChapterPlanSchema).max(500).default([]),
  /** 文风规格；随故事线快照、bundle 与发布协议一起流转。 */
  styleProfile: StyleProfileSchema.nullable().default(null),
  /** 二创声明（仅二创小说有）。 */
  derivative: DerivativeDeclSchema.nullable().default(null),
});
export type StorylineDoc = z.infer<typeof StorylineDocSchema>;

export function emptyStoryline(): StorylineDoc {
  return { version: 1, premise: '', themes: [], characters: [], settings: [], arcs: [], beats: [], chapters: [], styleProfile: null, derivative: null };
}

// ---- Story bible ----

export const BibleCharacterStateSchema = z.object({
  name: z.string().default(''),
  state: z.string().default(''),
  location: z.string().max(200).default(''),
  knowledge: z.string().default(''),
  relationships: z.array(z.string().max(300)).default([]),
});

export const StoryBibleSchema = z.object({
  characters: z.record(z.string(), BibleCharacterStateSchema).default({}),
  timeline: z.array(z.object({ chapterNo: z.number().int(), event: z.string() })).default([]),
  facts: z.array(z.string()).default([]),
  openThreads: z.array(z.string()).default([]),
  arcSummaries: z.record(z.string(), z.string().max(4000)).default({}),
  styleNotes: z.string().max(4000).default(''),
});
export type StoryBible = z.infer<typeof StoryBibleSchema>;

export function emptyBible(): StoryBible {
  return { characters: {}, timeline: [], facts: [], openThreads: [], arcSummaries: {}, styleNotes: '' };
}
