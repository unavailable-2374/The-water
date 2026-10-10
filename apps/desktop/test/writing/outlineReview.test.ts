/** THIS IS SIMULATED: tests use scripted review judgments, real SQLite and adoption guards. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OutlineReviewSchema, outlineReviewBlocks } from '@the-water/shared';
import { simulatedOutlineReview } from '../helpers/outlineReview';
import { useTestDb } from '../helpers/testDb';
import { createNovel, updateNovel } from '@/db/repos/novelsRepo';
import { defaultRequirements } from '@/novel/types';
import { buildStorylineDoc, upsertArc } from '@/db/repos/storylineRepo';
import { proposeDocumentPlan, listDocumentPlans, acceptDocumentPlan, documentPlanIssue } from '@/db/repos/planProposalsRepo';
import { reviewOutlineProposal, outlineReviewInput, outlineReviewPrompt, recoverOutlineReviews } from '@/novel/outlineReview';
import { saveWritingCard } from '@/db/repos/writingRepo';
import { setSetting } from '@/db/repos/settingsRepo';
import type { LLMProvider } from '@/llm/types';
const response = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('@/llm/json', async original => ({ ...await original<typeof import('@/llm/json')>(), requestJson: async (_p: unknown, spec: any) => ({ value: spec.schema.parse(await response.call(spec)), usage: { inputTokens: 10, outputTokens: 20 } }) }));
const provider = { id: 'TEST SIMULATED', kind: 'openai_compatible', model: 'TEST SIMULATED', caps: { contextWindow: 1000000, maxOutputTokens: 20000, cjkTokenRatio: 0.7, jsonMode: 'json_schema' }, async *stream() { throw new Error('TEST SIMULATED requestJson fixture must handle this call'); } } satisfies LLMProvider;
let db: ReturnType<typeof useTestDb>;
beforeEach(() => { db = useTestDb(); response.call.mockReset(); response.call.mockImplementation(simulatedOutlineReview); });
afterEach(() => db.raw.close());
async function fixture() {
  const novel = await createNovel({ title: 'TEST', premise: 'TEST 重生只保留记忆，实物不能跨时间线', targetChars: 3000, requirements: defaultRequirements() });
  await upsertArc(novel.id, { title: 'TEST arc', summary: 'TEST ending', startChapterNo: 1, endChapterNo: 3 });
  const after = await buildStorylineDoc(novel.id, novel.premise, []);
  const id = await proposeDocumentPlan(novel.id, after, 'TEST', { outlineDone: true, logline: 'TEST complete mainline', outlineReviewRequired: true });
  return { novel, id, after };
}
it('TEST blocks unreviewed and critical contradictory plans, never mutates adopted story on refusal', async () => {
  const f = await fixture(); await expect(acceptDocumentPlan(f.novel.id, f.id)).rejects.toThrow('审查尚未完成');
  response.call.mockImplementation(() => ({ ...simulatedOutlineReview(), findings: [{ dimension: 'causality', kind: 'contradiction', priority: 'critical', location: 'TEST premise', problem: 'TEST SIMULATED contradiction', evidence: [{ location: 'TEST premise', excerpt: '实物不能跨时间线' }], impact: 'TEST invalid ending', suggestion: 'TEST reacquire' }] }));
  await reviewOutlineProposal(f.novel.id, f.id, { provider });
  expect(documentPlanIssue((await listDocumentPlans(f.novel.id))[0]!)).toContain('关键矛盾');
  await expect(acceptDocumentPlan(f.novel.id, f.id)).rejects.toThrow('关键矛盾');
  expect(await buildStorylineDoc(f.novel.id, f.novel.premise, [])).toEqual(f.after);
});
it('TEST aesthetic choices do not block; unknown information is not forged into a contradiction', async () => {
  const f = await fixture(); response.call.mockImplementation(() => ({ ...simulatedOutlineReview(), findings: [{ dimension: 'pacing', kind: 'aesthetic_choice', priority: 'optional', location: 'TEST arc', problem: 'TEST SIMULATED slow pace preference', evidence: [], impact: 'TEST subjective', suggestion: 'TEST optional' }] }));
  await reviewOutlineProposal(f.novel.id, f.id, { provider }); await acceptDocumentPlan(f.novel.id, f.id);
});
it('TEST failed review persists exact error and retries without regenerating the outline', async () => {
  const f = await fixture(); response.call.mockRejectedValueOnce(new Error('TEST exact review failure'));
  await expect(reviewOutlineProposal(f.novel.id, f.id, { provider })).rejects.toThrow('TEST exact review failure');
  expect((await listDocumentPlans(f.novel.id))[0]!.meta.outlineReview).toMatchObject({ state: 'failed', error: 'TEST exact review failure' });
  await reviewOutlineProposal(f.novel.id, f.id, { provider });
  expect((await listDocumentPlans(f.novel.id))[0]!.after).toEqual(f.after);
  expect((await listDocumentPlans(f.novel.id))[0]!.meta.outlineReview).toMatchObject({ state: 'complete' });
});
it('TEST repeated requests reuse a completed report; author constraint edits invalidate it', async () => {
  const f = await fixture(); await Promise.all([reviewOutlineProposal(f.novel.id, f.id, { provider }), reviewOutlineProposal(f.novel.id, f.id, { provider })]);
  await reviewOutlineProposal(f.novel.id, f.id, { provider }); expect(response.call).toHaveBeenCalledTimes(1);
  await setSetting(`authorNote:${f.novel.id}`, 'TEST new hard constraint');
  await expect(acceptDocumentPlan(f.novel.id, f.id)).rejects.toThrow('约束已变化');
  await reviewOutlineProposal(f.novel.id, f.id, { provider }); expect(response.call).toHaveBeenCalledTimes(2);
  await saveWritingCard(f.novel.id, { kind: 'brief', data: { premise: 'TEST changed card', mainline: 'TEST goal', ending: 'TEST ending', audience: 'TEST reader', constraints: [], rollingChapters: 5 } }, { confirmed: true });
  await expect(acceptDocumentPlan(f.novel.id, f.id)).rejects.toThrow('约束已变化');
  await reviewOutlineProposal(f.novel.id, f.id, { provider });
  await updateNovel(f.novel.id, { targetChars: 9000 }); await expect(acceptDocumentPlan(f.novel.id, f.id)).rejects.toThrow('约束已变化');
});
it('TEST restarts recover interrupted reviews and read-only inspection cannot be adopted', async () => {
  const f = await fixture(); const p = (await listDocumentPlans(f.novel.id))[0]!;
  p.meta.outlineReview = { state: 'running', signature: 'TEST', error: null, report: null, reviewedAt: 0 }; p.meta.outlineReviewOnly = true;
  await db.execute('UPDATE writing_proposals SET json=? WHERE id=?', [JSON.stringify(p), f.id]); await recoverOutlineReviews();
  expect((await listDocumentPlans(f.novel.id))[0]!.meta.outlineReview).toHaveProperty('state', 'interrupted');
  await expect(acceptDocumentPlan(f.novel.id, f.id)).rejects.toThrow('只生成报告');
});
it('TEST review schema rejects invented evidence and missing dimensions', async () => {
  const f = await fixture(), p = (await listDocumentPlans(f.novel.id))[0]!, schema = outlineReviewPrompt(await outlineReviewInput(f.novel.id, p)).schema;
  const report = simulatedOutlineReview(); report.checks[0] = { ...report.checks[0]!, status: 'supported', evidence: [{ location: 'TEST', excerpt: 'THIS WAS NOT IN THE INPUT' }] };
  expect(() => schema.parse(report)).toThrow('引用在输入中不存在');
  report.checks[1]!.dimension = report.checks[0]!.dimension; expect(() => OutlineReviewSchema.parse(report)).toThrow('全部十二个维度');
  expect(() => OutlineReviewSchema.parse({ ...simulatedOutlineReview(), findings: [{ dimension: 'causality', kind: 'aesthetic_choice', priority: 'critical', location: 'TEST', problem: 'TEST contradictory classification', evidence: [], impact: 'TEST', suggestion: 'TEST' }] })).toThrow('审美选择不能标 critical');
  expect(outlineReviewBlocks({ ...simulatedOutlineReview(), findings: [{ dimension: 'ending', kind: 'missing_information', priority: 'critical', location: 'TEST ending', problem: 'TEST missing ending', evidence: [], impact: 'TEST cannot assess', suggestion: 'TEST supply ending' }] })).toBe(true);
});
