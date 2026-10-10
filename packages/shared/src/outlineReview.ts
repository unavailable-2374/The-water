import { z } from 'zod';
import { canonicalJson, sha256Hex } from './hash';

export const OUTLINE_REVIEW_DIMENSIONS = ['reader_promise', 'causality', 'character', 'accumulation', 'pacing', 'world_rules', 'information', 'integration', 'ending', 'writeability', 'genre', 'form'] as const;
const text = z.string().trim().min(1).max(6000);
const evidence = z.object({ location: text, excerpt: text.describe('输入中逐字存在的短片段，不得补造证据') });
export const OutlineReviewSchema = z.object({
  premise: z.object({ documentKind: text, stage: text, primaryExperience: text, audience: text, lengthAndReadingForm: text, uncertainties: z.array(text).max(20) }),
  summary: text.describe('编辑判断，不是客观质量评分或合格保证'),
  checks: z.array(z.object({ dimension: z.enum(OUTLINE_REVIEW_DIMENSIONS), status: z.enum(['supported', 'concern', 'needs_information', 'not_applicable']), assessment: text, evidence: z.array(evidence).max(6) })).length(12),
  causalChains: z.array(z.object({ location: text, priorConditions: text, action: text, change: text, consequence: text })).min(1).max(20),
  timeline: z.array(z.object({ event: text, happensAt: text, characterLearnsAt: text, readerLearnsAt: text, materialOriginAndTransfer: text })).min(1).max(20).describe('重要事件、线索和物件；未提供的时间明确写未提供，不猜测日期'),
  findings: z.array(z.object({ dimension: z.enum(OUTLINE_REVIEW_DIMENSIONS), kind: z.enum(['contradiction', 'missing_information', 'aesthetic_choice']), priority: z.enum(['critical', 'important', 'optional']), location: text, problem: text, evidence: z.array(evidence).max(6), impact: text, suggestion: text })).max(40),
  proseValidation: z.array(text).max(12).describe('需要试写才能判断的对白、氛围、喜剧和感染力，不宣称大纲已证明'),
}).superRefine((report, ctx) => {
  if (new Set(report.checks.map(c => c.dimension)).size !== 12) ctx.addIssue({ code: 'custom', path: ['checks'], message: '审查必须逐项覆盖全部十二个维度，不能重复或跳项' });
  report.checks.forEach((c, i) => { if (['supported', 'concern'].includes(c.status) && !c.evidence.length) ctx.addIssue({ code: 'custom', path: ['checks', i, 'evidence'], message: '判断必须引用输入中的证据；缺少信息时应标 needs_information' }); });
  report.findings.forEach((f, i) => {
    if (f.kind === 'contradiction' && !f.evidence.length) ctx.addIssue({ code: 'custom', path: ['findings', i, 'evidence'], message: '认定矛盾必须提供输入证据' });
    if (f.kind === 'aesthetic_choice' && f.priority === 'critical') ctx.addIssue({ code: 'custom', path: ['findings', i, 'kind'], message: '审美选择不能标 critical；违反明确时间线或硬约束必须分类为 contradiction，关键事实未提供应分类为 missing_information' });
  });
});
export type OutlineReview = z.infer<typeof OutlineReviewSchema>;
export const OutlineReviewStateSchema = z.object({ state: z.enum(['running', 'interrupted', 'failed', 'complete']), signature: z.string(), error: z.string().nullable(), report: OutlineReviewSchema.nullable(), reviewedAt: z.number(), rawOutput: z.string().nullable().optional() });
export type OutlineReviewState = z.infer<typeof OutlineReviewStateSchema>;
export function outlineReviewBlocks(report: OutlineReview): boolean {
  return report.findings.some(f => f.priority === 'critical' && f.kind !== 'aesthetic_choice');
}
/** The report is tied to exactly the supplied outline and author constraints, excluding its own metadata. */
export function outlineReviewSignature(input: unknown): Promise<string> { return sha256Hex(canonicalJson(input)); }
