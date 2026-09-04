/**
 * StyleProfile：把"文风"拆成四层（量化 metrics / 定性 voice / 示例 exemplars / 负面 negatives）
 * 外加注入策略 injection。规范见 docs/writing/README.md §4。
 * 随 StorylineDoc 一起进入快照、bundle 与发布协议，因此所有字段都有默认值以保持向后兼容。
 */
import { z } from 'zod';

const short = (max = 200) => z.string().max(max).default('');
const long = (max = 2000) => z.string().max(max).default('');
const strList = (max = 50, itemMax = 200) => z.array(z.string().max(itemMax)).max(max).default([]);
const range = () => z.tuple([z.number(), z.number()]);

export const SceneType = z.enum(['opening', 'fight', 'dialogue', 'quiet', 'travel', 'reveal', 'climax', 'ending', 'other']);
export type SceneType = z.infer<typeof SceneType>;
export const SCENE_TYPE_LABEL: Record<SceneType, string> = {
  opening: '开场', fight: '打斗/冲突', dialogue: '对话', quiet: '静场/日常', travel: '过场', reveal: '揭示', climax: '高潮', ending: '收束', other: '其他',
};

/** 本地统计得出的量化特征（中文按字计）。 */
export const StyleMetricsSchema = z.object({
  sampledChars: z.number().int().min(0).default(0),
  sentenceLength: z.object({ mean: z.number(), sd: z.number(), p10: z.number(), p90: z.number() }).default({ mean: 0, sd: 0, p10: 0, p90: 0 }),
  /** 句长标准差 ÷ 均值；人类文本通常 > 0.45。 */
  burstiness: z.number().default(0),
  paragraphLength: z.object({ mean: z.number(), sd: z.number(), singleSentenceRatio: z.number() }).default({ mean: 0, sd: 0, singleSentenceRatio: 0 }),
  /** 引号内字数 ÷ 总字数。 */
  dialogueRatio: z.number().default(0),
  /** 每千字标点计数。 */
  punctuationPerK: z.record(z.string(), z.number()).default({}),
  /** 每千字虚词/语气词计数。 */
  functionWordsPerK: z.record(z.string(), z.number()).default({}),
  /** 高频且有区分度的 2–4 字词组。 */
  ngramSignature: strList(30, 20),
});
export type StyleMetrics = z.infer<typeof StyleMetricsSchema>;

/** 校验用目标区间（含容差）。缺省项不检查。 */
export const StyleTargetsSchema = z.object({
  sentenceMean: range().nullable().default(null),
  burstiness: range().nullable().default(null),
  paragraphMean: range().nullable().default(null),
  dialogueRatio: range().nullable().default(null),
  exclamationPerK: range().nullable().default(null),
  ellipsisPerK: range().nullable().default(null),
  /** 超出即打回的硬项（其余为软项，只记分）。 */
  hard: z.array(z.enum(['sentenceMean', 'burstiness', 'paragraphMean', 'dialogueRatio', 'exclamationPerK', 'ellipsisPerK'])).default(['sentenceMean', 'burstiness']),
});
export type StyleTargets = z.infer<typeof StyleTargetsSchema>;

export const VoiceTraitSchema = z.object({ text: long(1000), evidence: strList(5, 400) });
export type VoiceTrait = z.infer<typeof VoiceTraitSchema>;

export const SignatureMoveSchema = z.object({
  move: z.string().max(200),
  example: short(400),
  /** 每章出现次数区间，用于防止戏仿式过度模仿。 */
  frequencyPerChapter: range().default([0, 1]),
});

export const VOICE_DIMENSIONS = ['narrator', 'rhythm', 'imagery', 'dialogue', 'humor', 'emotion', 'genreConventions'] as const;
export type VoiceDimension = (typeof VOICE_DIMENSIONS)[number];
export const VOICE_DIMENSION_LABEL: Record<VoiceDimension, string> = {
  narrator: '叙述腔调', rhythm: '句式节奏', imagery: '意象与感官', dialogue: '对白规矩', humor: '幽默方式', emotion: '情感处理', genreConventions: '题材惯例',
};

const trait = () => VoiceTraitSchema.default({ text: '', evidence: [] });
export const StyleVoiceSchema = z.object({
  narrator: trait(),
  rhythm: trait(),
  imagery: trait(),
  dialogue: trait(),
  humor: trait(),
  emotion: trait(),
  genreConventions: trait(),
  signatureMoves: z.array(SignatureMoveSchema).max(10).default([]),
});
export type StyleVoice = z.infer<typeof StyleVoiceSchema>;

export const ExemplarSchema = z.object({
  id: z.string().max(64),
  sceneType: SceneType.catch('other'),
  text: z.string().max(1200),
  illustrates: z.array(z.string().max(40)).max(4).default([]),
});
export type Exemplar = z.infer<typeof ExemplarSchema>;

export const StyleNegativesSchema = z.object({
  avoidWords: strList(100, 40),
  avoidWordsSoft: z.object({ limitPerK: z.number().default(1), list: strList(100, 40) }).default({ limitPerK: 1, list: [] }),
  avoidPatterns: strList(50, 80),
  antiExemplars: z.array(z.object({ text: z.string().max(600), why: short(300) })).max(10).default([]),
  oocRedlines: strList(50, 200),
});
export type StyleNegatives = z.infer<typeof StyleNegativesSchema>;

export const StyleInjectionSchema = z.object({
  summaryBudget: z.number().int().min(80).max(1200).default(300),
  exemplarCount: z.number().int().min(0).max(6).default(3),
  /** 翻译成人话的 3–8 条硬约束；这是真正进 system prompt 的部分。 */
  humanReadableConstraints: strList(12, 200),
});

export const StyleSourceSchema = z.object({
  kind: z.enum(['preset', 'extracted', 'manual']).default('manual'),
  presetId: z.string().max(64).nullable().default(null),
  chaptersSampled: z.array(z.number().int()).max(200).default([]),
  extractedAt: z.string().max(40).nullable().default(null),
});

export const StyleProfileSchema = z.object({
  version: z.literal(1).default(1),
  id: z.string().max(64).default(''),
  name: z.string().max(100).default(''),
  source: StyleSourceSchema.default({ kind: 'manual', presetId: null, chaptersSampled: [], extractedAt: null }),
  metrics: StyleMetricsSchema.nullable().default(null),
  targets: StyleTargetsSchema.default({ sentenceMean: null, burstiness: null, paragraphMean: null, dialogueRatio: null, exclamationPerK: null, ellipsisPerK: null, hard: ['sentenceMean', 'burstiness'] }),
  voice: StyleVoiceSchema.default({
    narrator: { text: '', evidence: [] }, rhythm: { text: '', evidence: [] }, imagery: { text: '', evidence: [] }, dialogue: { text: '', evidence: [] },
    humor: { text: '', evidence: [] }, emotion: { text: '', evidence: [] }, genreConventions: { text: '', evidence: [] }, signatureMoves: [],
  }),
  exemplars: z.array(ExemplarSchema).max(12).default([]),
  negatives: StyleNegativesSchema.default({ avoidWords: [], avoidWordsSoft: { limitPerK: 1, list: [] }, avoidPatterns: [], antiExemplars: [], oocRedlines: [] }),
  injection: StyleInjectionSchema.default({ summaryBudget: 300, exemplarCount: 3, humanReadableConstraints: [] }),
});
export type StyleProfile = z.infer<typeof StyleProfileSchema>;

export function emptyStyleProfile(patch: Partial<StyleProfile> = {}): StyleProfile {
  return StyleProfileSchema.parse({ ...patch });
}

/** 二创声明：从原著哪里分岔、必须保持什么、允许改什么。 */
export const DerivativeKind = z.enum(['sequel', 'sidestory', 'au', 'pov-switch', 'crossover', 'rewrite']);
export type DerivativeKind = z.infer<typeof DerivativeKind>;
export const DERIVATIVE_KIND_LABEL: Record<DerivativeKind, string> = {
  sequel: '续写', sidestory: '番外', au: '平行世界', 'pov-switch': '视角转换', crossover: '联动', rewrite: '改编',
};

export const DerivativeDeclSchema = z.object({
  kind: DerivativeKind.default('sequel'),
  divergencePoint: short(300),
  mustKeep: strList(30, 200),
  allowedChanges: strList(30, 200),
  audience: z.enum(['fans', 'general']).default('fans'),
  /** 期望的风格相似度 0–1，决定容差带宽度。 */
  styleFidelity: z.number().min(0).max(1).default(0.85),
});
export type DerivativeDecl = z.infer<typeof DerivativeDeclSchema>;

export function emptyDerivative(): DerivativeDecl {
  return DerivativeDeclSchema.parse({});
}

/** 由测量值推导目标区间：区间 = 值 × (1 ± tolerance)，fidelity 越高容差越窄。 */
export function targetsFromMetrics(m: StyleMetrics, fidelity = 0.85): StyleTargets {
  const tol = Math.max(0.15, Math.min(0.6, 1 - fidelity + 0.15));
  const band = (v: number): [number, number] => [round(v * (1 - tol)), round(v * (1 + tol))];
  const cap = (v: number): [number, number] => [0, round(Math.max(1, v * (1 + tol) + 1))];
  return {
    sentenceMean: m.sentenceLength.mean > 0 ? band(m.sentenceLength.mean) : null,
    burstiness: m.burstiness > 0 ? band(m.burstiness) : null,
    paragraphMean: m.paragraphLength.mean > 0 ? band(m.paragraphLength.mean) : null,
    dialogueRatio: m.dialogueRatio > 0 ? [round(Math.max(0, m.dialogueRatio - tol / 2)), round(Math.min(1, m.dialogueRatio + tol / 2))] : null,
    exclamationPerK: cap(m.punctuationPerK['！'] ?? 0),
    ellipsisPerK: cap(m.punctuationPerK['……'] ?? 0),
    hard: ['sentenceMean', 'burstiness'],
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
