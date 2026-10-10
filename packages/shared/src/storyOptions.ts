import { z } from 'zod';

const text = z.string().min(1).max(8000);
export const StoryOptionScopeSchema = z.object({
  kind: z.enum(['work', 'arc', 'chapter', 'scene']), id: z.string().min(1),
});
export type StoryOptionScope = z.infer<typeof StoryOptionScopeSchema>;
export const StoryOptionModeSchema = z.enum(['continue', 'restructure']);
export const StoryOptionAmplitudeSchema = z.enum(['close', 'moderate', 'bold']);
export const StoryOptionDesignSchema = z.object({
  causalSpine: text.describe('决定此候选后续局势的独特因果主干，不写题材标签'),
  decisiveChoice: text.describe('最有区分度的主动选择及其代价'),
  resolutionMechanism: text.describe('高潮如何使用前文准备解决核心问题'),
});
export const StoryOptionContentSchema = z.object({
  design: StoryOptionDesignSchema.optional(),
  outline: z.array(text).min(4).max(16).optional().describe('全书候选大纲：4–16 段，连贯覆盖开端、发展、危机/高潮、结局；不是零散节点。旧版候选可缺省'),
  title: text, mainline: text.describe('一句话概括主角为目标采取的行动及核心后果，不只是开场设定'), conflict: text,
  choiceAndCost: text.describe('主动选择、得到什么、失去什么；具体代价须与选择有因果关系'),
  growth: text.describe('人物从何种信念/行为模式，经过怎样的选择，改变为何种新信念/行为；不能只复述揭密'),
  turns: z.array(text).min(1).max(12), ending: text.describe('与所选范围对应的结果；场景给场景结果，不跳到全书结局'), aftermath: text.describe('范围内结果对后续计划的影响；不得把范围外情节写成必须已经发生的事实'),
});
export const StoryOptionSchema = StoryOptionContentSchema.extend({ id: z.string().min(1) });
export type StoryOption = z.infer<typeof StoryOptionSchema>;
export const StoryOptionFindingSchema = z.object({
  kind: z.enum(['hard_constraint', 'contradiction', 'missing_information', 'editorial']),
  field: z.enum(['outline', 'mainline', 'conflict', 'choiceAndCost', 'growth', 'turns', 'ending', 'aftermath', 'causalSpine', 'decisiveChoice', 'resolutionMechanism']),
  quote: text.describe('候选对应字段中的逐字引文，不得改写'),
  authorQuote: z.string().max(8000).describe('硬约束问题须逐字引用本次作者输入；其他问题可为空'),
  explanation: text, revision: text,
});
export const StoryOptionChecksSchema = z.object({
  fieldConsistency: text, causality: text, characterRequirements: text, payoffs: text, distinctness: text,
});
export const StoryOptionAuditSchema = z.object({
  checkpoint: z.enum(['scopeCoverage', 'promisePayoff', 'characterProcess', 'resolutionSetup', 'lastingConsequences']),
  status: z.enum(['supported', 'gap', 'not_applicable']),
  explanation: text,
  evidence: z.array(z.object({ field: z.enum(['outline', 'turns']), quote: text })).max(12),
  findingIndices: z.array(z.number().int().nonnegative()).max(20).describe('本卡 findings 数组的零起始下标：第一条为 0。gap 必须关联至少一条非 editorial 问题；supported/not_applicable 必须为 []'),
});
export const StoryOptionDifferenceSchema = z.object({
  leftId: z.string(), rightId: z.string(), judgment: z.enum(['substantive', 'cosmetic', 'undetermined']),
  axes: z.array(z.object({ axis: z.enum(['causalSpine', 'decisiveChoice', 'resolutionMechanism']), leftQuote: text, rightQuote: text, explanation: text })).max(3),
});
export const StoryOptionComparisonSchema = z.object({
  summary: text,
  differences: z.array(StoryOptionDifferenceSchema).max(6).optional(),
  options: z.array(z.object({
    optionId: z.string().min(1), conflict: text, character: text, turns: text,
    emotion: text, ending: text, tradeoff: text,
    concerns: z.array(text).default([]).describe('需要在细化时处理的编辑建议、因果薄弱或歧义，不等于违反作者硬约束'),
    violations: z.array(text), requiresWiderScope: z.boolean(),
    checks: StoryOptionChecksSchema.optional(), findings: z.array(StoryOptionFindingSchema).optional(),
    qualityAudit: z.array(StoryOptionAuditSchema).length(5).optional().describe('旧报告可缺省；新审查必须提供五项事件依据'),
  })).min(1).max(4),
});
export type StoryOptionComparison = z.infer<typeof StoryOptionComparisonSchema>;
export const StoryOptionBoundarySchema = z.object({
  chapterId: z.string(), chapterNo: z.number().int(), versionId: z.string(),
  contentHash: z.string(), offset: z.number().int().nonnegative(),
}).nullable();
export const StoryOptionBatchSchema = z.object({
  id: z.string(), sessionId: z.string(), requestKey: z.string(),
  scope: StoryOptionScopeSchema, mode: StoryOptionModeSchema, amplitude: StoryOptionAmplitudeSchema,
  boundary: StoryOptionBoundarySchema, dependencyHash: z.string(),
  inputSnapshot: z.record(z.string(), z.unknown()), feedback: z.string(),
  optionIds: z.array(z.string()).max(4), keptIds: z.array(z.string()).max(4),
  comparison: StoryOptionComparisonSchema.nullable(),
  state: z.enum(['candidates', 'comparison', 'ready', 'interrupted', 'failed']),
  error: z.string().nullable(), createdAt: z.number(),
});
export type StoryOptionBatch = z.infer<typeof StoryOptionBatchSchema>;
