import { z } from 'zod';

const id = z.string().min(1).max(100);
const prose = z.string().max(12000);
const ids = z.array(id).max(200);
/** Fiction-only adapter. V1 storyline and nonfiction documents remain independent. */
export const WritingBriefSchema = z.object({
  premise: prose,
  mainline: prose,
  ending: prose,
  audience: prose,
  // Optional for legacy cards: absent values remain unspecified.
  readingExperience: prose.optional(),
  distinctiveApproach: prose.optional(),
  protagonistLimits: prose.optional(),
  firstChoice: prose.optional(),
  choiceConsequences: prose.optional(),
  storyEngine: prose.optional(),
  endingConditions: prose.optional(),
  constraints: z.array(prose).max(100),
  rollingChapters: z.number().int().min(1).max(5).default(5),
});
export type WritingBrief = z.infer<typeof WritingBriefSchema>;
export const VolumePlanSchema = z
  .object({
    title: prose,
    summary: prose,
    startChapterNo: z.number().int().min(1).max(500),
    endChapterNo: z.number().int().min(1).max(500),
    arcIds: ids,
  })
  .refine((v) => v.startChapterNo <= v.endChapterNo, 'Invalid volume range');
export type VolumePlan = z.infer<typeof VolumePlanSchema>;
export const ScenePlanSchema = z.object({
  title: prose,
  volumeId: id.nullable(),
  povCharacterId: id.nullable(),
  time: prose,
  location: prose,
  characterIds: ids,
  goal: prose,
  obstacle: prose,
  turn: prose,
  outcome: prose,
  readerInterest: prose.optional(),
  choice: prose.optional(),
  choiceReason: prose.optional(),
  consequence: prose.optional(),
  beforeState: prose.optional(),
  afterState: prose.optional(),
  presentation: z.enum(['dramatize', 'summarize']).optional(),
  targetChars: z.number().int().min(100).max(10000),
  dependencyIds: ids,
  threadIds: ids,
});
export type ScenePlan = z.infer<typeof ScenePlanSchema>;
export const ThreadMilestoneSchema = z.object({
  chapterNo: z.number().int().min(1).max(500),
  kind: z.enum(['setup', 'progress', 'payoff']),
  detail: z.string().trim().min(1).max(4000),
});
export const StoryThreadSchema = z.object({
  title: prose,
  setup: prose,
  progression: prose,
  payoff: prose,
  plannedChapterNo: z.number().int().min(1).max(500).nullable(),
  characterIds: ids,
  /** Author-confirmed planned stages, separate from evidence-backed canon lifecycle. */
  milestones: z.array(ThreadMilestoneSchema).max(100).optional(),
}).superRefine((thread, ctx) => {
  const steps = thread.milestones;
  if (!steps?.length) return; // Legacy cards have no invented schedule.
  if (steps[0]?.kind !== 'setup' || steps.at(-1)?.kind !== 'payoff') ctx.addIssue({ code: 'custom', path: ['milestones'], message: '伏笔阶段必须从埋设开始，以回收结束' });
  steps.forEach((step, i) => {
    if (i > 0 && step.chapterNo <= steps[i - 1]!.chapterNo) ctx.addIssue({ code: 'custom', path: ['milestones', i, 'chapterNo'], message: '伏笔阶段须跨章递增，不能提前回收' });
    if (i > 0 && i < steps.length - 1 && step.kind !== 'progress') ctx.addIssue({ code: 'custom', path: ['milestones', i, 'kind'], message: '中间阶段必须为推进' });
  });
  if (thread.plannedChapterNo !== null && thread.plannedChapterNo !== steps.at(-1)?.chapterNo) ctx.addIssue({ code: 'custom', path: ['plannedChapterNo'], message: '计划回收章必须与末次回收阶段一致' });
});
export type StoryThread = z.infer<typeof StoryThreadSchema>;
export const CharacterIntentSchema = z.object({
  characterId: id,
  goal: prose,
  motivation: prose,
  contradiction: prose,
  fear: prose.optional(),
  belief: prose.optional(),
  habitualStrategy: prose.optional(),
  independentAgenda: prose.optional(),
  growth: z.array(z.object({ chapterNo: z.number().int().min(1).max(500), change: prose })).max(500),
});
export const WritingCardDataSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('brief'), data: WritingBriefSchema }),
  z.object({ kind: z.literal('volume'), data: VolumePlanSchema }),
  z.object({ kind: z.literal('scene'), data: ScenePlanSchema }),
  z.object({ kind: z.literal('thread'), data: StoryThreadSchema }),
  z.object({ kind: z.literal('character'), data: CharacterIntentSchema }),
]);
export type WritingCardData = z.infer<typeof WritingCardDataSchema>;
export const EvidenceSchema = z
  .object({
    from: z.number().int().min(0),
    to: z.number().int().min(0),
    quote: z.string().min(1).max(4000),
  })
  .refine((v) => v.to > v.from, 'Empty evidence range');
/** Editorial assessment, not a measurement of real reader satisfaction. Legacy reports remain unspecified. */
export const StoryAssessmentSchema = z.object({
  readingFocus: z.string().min(1).max(1200),
  changes: z.array(z.object({
    kind: z.enum(['goal', 'relationship', 'knowledge', 'emotion']),
    before: z.string().min(1).max(1200), after: z.string().min(1).max(1200), evidence: EvidenceSchema,
  })).max(20),
  expectations: z.array(z.object({
    id: z.string().min(1).max(100),
    question: z.string().min(1).max(1200), response: z.string().min(1).max(1200),
    status: z.enum(['advanced', 'paid', 'deferred']), evidence: EvidenceSchema,
  })).max(20),
  nextInterest: z.string().max(1200),
  verdict: z.enum(['ready', 'revise', 'replan']),
  reason: z.string().min(1).max(1600),
});
export type StoryAssessment = z.infer<typeof StoryAssessmentSchema>;
export const ReviewIssueSchema = z.object({
  id,
  category: z.enum([
    'causality',
    'motivation',
    'voice',
    'knowledge',
    'timeline',
    'canon',
    'thread',
    'ending',
    'style',
    'repetition',
  ]),
  severity: z.enum(['block', 'suggestion']),
  evidence: EvidenceSchema,
  basis: prose.min(1),
  suggestion: prose.min(1),
  sourceIds: ids,
});
export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;
/** Editorial length judgment links to verified narrative evidence, never to a word-count quota. */
export const ChapterLengthReviewSchema = z.object({
  action: z.enum(['keep', 'expand', 'trim', 'mixed']),
  reason: z.string().min(1).max(1600),
  actions: z.array(z.object({ action: z.enum(['expand', 'trim']), issueId: z.string().min(1).max(100) })).max(40),
}).superRefine((value, ctx) => {
  const kinds = new Set(value.actions.map(item => item.action));
  const expected = kinds.size === 0 ? 'keep' : kinds.size === 2 ? 'mixed' : kinds.has('expand') ? 'expand' : 'trim';
  if (value.action !== expected) ctx.addIssue({ code: 'custom', path: ['action'], message: '篇幅结论必须与有依据的扩写、精简建议一致。' });
  if (new Set(value.actions.map(item => `${item.action}:${item.issueId}`)).size !== value.actions.length) ctx.addIssue({code:'custom',path:['actions'],message:'重复的篇幅建议。'});
});
export type ChapterLengthReview = z.infer<typeof ChapterLengthReviewSchema>;
export const CanonEventSchema = z.object({
  id,
  kind: z.enum([
    'fact',
    'event',
    'state',
    'relationship',
    'knowledge',
    'thread_setup',
    'thread_progress',
    'thread_payoff',
  ]),
  entityId: id.nullable(),
  threadId: id.nullable(),
  text: prose.min(1),
  knownBy: ids,
  time: prose,
  location: prose,
  dependencyIds: ids,
  evidence: EvidenceSchema,
});
export type CanonEvent = z.infer<typeof CanonEventSchema>;
export const TextProposalSchema = z.object({
  id,
  chapterId: id,
  baseVersionId: id,
  baseHash: z.string().length(64),
  operation: z.enum(['continue', 'rewrite', 'expand', 'condense', 'dialogue', 'action']),
  from: z.number().int().min(0),
  to: z.number().int().min(0),
  original: z.string(),
  replacement: z.string(),
  sourceIds: ids,
  sourceHashes: z.array(z.object({ id, hash: z.string().length(64) })).optional(),
  mandateId: id.optional(),
  graphHash: z.string().length(64).optional(),
  dependencyHash: z.string().length(64).optional(),
});
export type TextProposal = z.infer<typeof TextProposalSchema>;
export interface ChapterCommit {
  id: string;
  chapterId: string;
  versionId: string;
  contentHash: string;
  reviewId: string | null;
  dependencyHash: string;
  kind: 'reviewed' | 'legacy';
  createdAt: number;
}

export function verifyEvidence(text: string, evidence: { from: number; to: number; quote: string }): boolean {
  return (
    evidence.from >= 0 &&
    evidence.to > evidence.from &&
    text.slice(evidence.from, evidence.to) === evidence.quote
  );
}

/** Models can miscount UTF-16. Repair only a unique, byte-for-byte quotation. */
export function anchorEvidence(
  text: string,
  evidence: { from: number; to: number; quote: string },
): { from: number; to: number; quote: string } {
  if (verifyEvidence(text, evidence)) return evidence;
  const from = text.indexOf(evidence.quote);
  if (!evidence.quote || from < 0 || text.indexOf(evidence.quote, from + 1) >= 0)
    throw new Error('Evidence quote is missing or ambiguous');
  return { from, to: from + evidence.quote.length, quote: evidence.quote };
}
