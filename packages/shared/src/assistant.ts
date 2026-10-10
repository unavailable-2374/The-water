import { StoryOptionScopeSchema, StoryOptionModeSchema, StoryOptionAmplitudeSchema } from './storyOptions';
import { z } from 'zod';
import {
  CharacterSchema,
  SettingSchema,
  ArcSchema,
  BeatSchema,
  ChapterPlanSchema,
} from './storyline';
import { StyleProfileSchema, DerivativeDeclSchema } from './style';
import { ScenePlanSchema, WritingCardDataSchema } from './writing';
import { StoryGraphSchema } from './storyGraph';

const id = z.string().min(1).max(100);
const text = z.string().max(12000);
export const DOCUMENT_TYPE_IDS = [
  'long-webnovel',
  'short-story',
  'screenplay',
  'fanfic',
  'tech-blog',
  'wechat-post',
  'essay',
  'news',
  'popsci',
  'academic',
] as const;
/** Captured once per turn. Execution never follows a later UI selection. */
export const AssistantContextSchema = z.object({
  novelId: id.nullable().default(null),
  chapterId: id.nullable().default(null),
  selection: z
    .object({
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
      versionId: id,
      contentHash: z.string().length(64),
    })
    .nullable()
    .default(null),
  objectIds: z.array(id).max(200).default([]),
  sourceIds: z.array(id).max(200).default([]),
});
export type AssistantContext = z.infer<typeof AssistantContextSchema>;
const requirements = z
  .object({
    genre: text.optional(),
    style: text.optional(),
    pov: text.optional(),
    tense: text.optional(),
    tone: text.optional(),
    audience: text.optional(),
    taboos: z.array(text).optional(),
    mustHave: z.array(text).optional(),
    language: text.optional(),
    extra: text.optional(),
    docType: z.enum(DOCUMENT_TYPE_IDS).optional(),
    genrePackIds: z.array(id).optional(),
    disabledLore: z.array(id).optional(),
  })
  .strict();
export const assistantParameters = {
  story_options: z.object({ action: z.enum(['generate','redraw','retain','history','resume','combine']), scope: StoryOptionScopeSchema, mode: StoryOptionModeSchema.optional(), amplitude: StoryOptionAmplitudeSchema.default('moderate'), feedback: z.string().default(''), authorMaterials: z.string().default('').describe('仅转述用户本轮明确提供的故事材料，不得从已有故事线或助手历史补入设定'), batchId: z.string().optional(), optionId: z.string().optional(), optionIds: z.array(z.string()).min(2).max(4).optional(), retained: z.boolean().optional() }).strict(),
  inspect: z
    .object({
      section: z.enum([
        'overview',
        'chapters',
        'chapter',
        'plans',
        'graph',
        'candidates',
        'jobs',
        'history',
        'materials',
        'facts',
        'versions',
        'branches',
        'readings',
        'story_history',
      ]),
      id: id.optional(),
    })
    .strict(),
  create_work: z
    .object({
      title: text.min(1),
      premise: text,
      targetChars: z.number().int().min(100).max(10000000),
      requirements,
    })
    .strict(),
  edit_work: z
    .object({
      title: text.optional(),
      premise: text.optional(),
      targetChars: z.number().int().min(100).max(10000000).optional(),
      requirements: requirements.optional(),
    })
    .strict(),
  import_manuscript: z.object({ title: text.min(1), requirements }).strict(),
  export_work: z
    .object({
      format: z.enum(['txt', 'md', 'epub', 'docx']),
      draft: z.boolean().default(false),
      from: z.number().int().positive().optional(),
      to: z.number().int().positive().optional(),
    })
    .strict(),
  character: z.object({ value: CharacterSchema }).strict(),
  setting: z.object({ value: SettingSchema }).strict(),
  arc: z.object({ value: ArcSchema }).strict(),
  beat: z.object({ value: BeatSchema }).strict(),
  remove_entity: z
    .object({ kind: z.enum(['characters', 'settings', 'arcs', 'beats']), id })
    .strict(),
  style: z.object({ value: StyleProfileSchema.nullable() }).strict(),
  card: z
    .object({
      id: id.optional(),
      chapterId: id.nullable().optional(),
      order: z.number().int().nonnegative().optional(),
      confirmed: z.boolean(),
      value: WritingCardDataSchema,
    })
    .strict(),
  chapter_plan: z.object({ value: ChapterPlanSchema }).strict(),
  graph: z.object({ value: StoryGraphSchema, reason: text.min(1) }).strict(),
  reorder_chapters: z.object({ ids: z.array(id).min(1).max(500) }).strict(),
  split_chapter: z.object({ chapterId: id, offset: z.number().int().positive() }).strict(),
  merge_chapters: z.object({ firstId: id, secondId: id }).strict(),
  cancel_merge: z.object({ chapterId: id }).strict(),
  reorder_cards: z.object({ ids: z.array(id).min(1).max(500) }).strict(),
  split_scene: z.object({ id }).strict(),
  merge_scenes: z.object({ firstId: id, secondId: id }).strict(),
  edit_text: z
    .object({
      chapterId: id,
      baseVersionId: id.nullable(),
      baseHash: z.string().length(64).nullable(),
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
      replacement: z.string().max(200000),
    })
    .strict(),
  restore_version: z.object({ chapterId: id, versionId: id }).strict(),
  candidate: z.object({ id, action: z.enum(['accept', 'discard']) }).strict(),
  plan: z.object({ stage: z.enum(['outline', 'chapters', 'both']) }).strict(),
  write: z.object({ chapterIds: z.array(id).max(500).optional() }).strict(),
  rewrite: z.object({ chapterIds: z.array(id).min(1).max(500), instruction: text.min(1) }).strict(),
  review: z.object({ chapterIds: z.array(id).min(1).max(500) }).strict(),
  extract_style: z.object({}).strict(),
  finish_work: z
    .object({
      goal: text.min(1),
      constraints: z.array(text).max(100),
      chapterIds: z.array(id).max(500).optional(),
    })
    .strict(),
  rewrite_candidate: z.object({ chapterId: id, action: z.enum(['accept', 'discard']) }).strict(),
  repair_memory: z.object({ jobId: id }).strict(),
  author_note: z.object({ value: z.string().max(1200) }).strict(),
  derivative: z.object({ value: DerivativeDeclSchema.nullable() }).strict(),
  task: z.object({ id, action: z.enum(['pause', 'resume', 'cancel']) }).strict(),
  undo: z.object({ operationId: id.optional(), runId: id.optional() }).strict(),
  branch_create: z.object({ nodeId: id, name: text.min(1) }).strict(),
  branch_edit: z
    .object({
      id,
      name: text.min(1),
      plan: ScenePlanSchema,
      graph: StoryGraphSchema,
      sample: z.string().max(200000),
    })
    .strict(),
  read_prose: z.object({ chapterId: id }).strict(),
  reading_candidate: z.object({ id, action: z.enum(['accept', 'discard']) }).strict(),
  suggest_voice: z.object({}).strict(),
  restore_story_change: z.object({ id }).strict(),
  branch_sample: z.object({ id, instruction: text.min(1) }).strict(),
  branch_merge: z.object({ id, prose: z.boolean() }).strict(),
} as const;
export type AssistantOperationName = keyof typeof assistantParameters;
const operation = <N extends AssistantOperationName>(name: N) =>
  z.object({ name: z.literal(name), parameters: assistantParameters[name] });
export const AssistantOperationSchema = z.discriminatedUnion('name', [
  operation('story_options'),
  operation('inspect'),
  operation('create_work'),
  operation('edit_work'),
  operation('import_manuscript'),
  operation('export_work'),
  operation('character'),
  operation('setting'),
  operation('arc'),
  operation('beat'),
  operation('remove_entity'),
  operation('style'),
  operation('card'),
  operation('chapter_plan'),
  operation('graph'),
  operation('reorder_chapters'),
  operation('split_chapter'),
  operation('merge_chapters'),
  operation('cancel_merge'),
  operation('reorder_cards'),
  operation('split_scene'),
  operation('merge_scenes'),
  operation('edit_text'),
  operation('restore_version'),
  operation('candidate'),
  operation('plan'),
  operation('write'),
  operation('rewrite'),
  operation('review'),
  operation('extract_style'),
  operation('finish_work'),
  operation('rewrite_candidate'),
  operation('repair_memory'),
  operation('derivative'),
  operation('author_note'),
  operation('task'),
  operation('undo'),
  operation('branch_create'),
  operation('branch_edit'),
  operation('read_prose'),
  operation('reading_candidate'),
  operation('suggest_voice'),
  operation('restore_story_change'),
  operation('branch_sample'),
  operation('branch_merge'),
]);
// Keep compile-time discrimination in sync with the runtime registry.
export type AssistantOperation = {
  [K in AssistantOperationName]: { name: K; parameters: z.infer<(typeof assistantParameters)[K]> };
}[AssistantOperationName];
export const AssistantDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answer'), text: text.min(1) }),
  z.object({ kind: z.literal('clarify'), text: text.min(1) }),
  z.object({
    kind: z.literal('operate'),
    intent: z.enum(['explicit_edit', 'authorized_continuation']),
    summary: text.min(1),
    completeAfterOperation: z.boolean().default(false),
    wholeWorkGoal: z
      .object({ goal: text.min(1), constraints: z.array(text).max(100) })
      .nullable()
      .default(null),
    operation: AssistantOperationSchema,
  }),
]);
export const AssistantStateSchema = z.enum([
  'running',
  'waiting_job',
  'needs_input',
  'paused',
  'completed',
  'partial',
  'failed',
  'cancelled',
  'undone',
]);
export type AssistantState = z.infer<typeof AssistantStateSchema>;
export const AssistantResultSchema = z.object({
  state: AssistantStateSchema,
  summary: z.string(),
  novelId: id.nullable(),
  objectIds: z.array(id),
  jobId: id.optional(),
  detail: z.unknown().optional(),
  error: z.string().optional(),
  location: z.string().optional(),
});
export type AssistantResult = z.infer<typeof AssistantResultSchema>;
export interface AssistantRun {
  id: string;
  conversationId: string;
  novelId: string | null;
  messageId: string;
  context: AssistantContext;
  state: AssistantState;
  goal: string;
  constraints: string[];
  jobId: string | null;
  error: string | null;
  createdAt: number;
}
