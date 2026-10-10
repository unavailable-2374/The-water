import { docTypeGuide } from '@/novel/docTypes';
import { selectOne } from '@/db/db';
import { reviewOutlineProposal } from '@/novel/outlineReview';
import { requirePlanAccepted } from '@/db/repos/planProposalsRepo';
import { setStepInput } from '@/db/repos/jobsRepo';
import { AwaitingReviewError } from '../awaitingReview';
/**
 * outline 步骤（§2.1 第 1 条）：把「生成大纲」从前台搬进后台任务。
 *
 * 好处不只是不阻塞界面：步骤状态、attempts、错误、部分输出都落在 job_steps 里，
 * 关掉应用再打开可以接着跑，失败可以单步重试。
 */
import { getNovel } from '@/db/repos/novelsRepo';
import { requestJson } from '@/llm/json';
import { outlinePrompt } from '@/llm/prompts/outline';
import { applyOutline } from '@/novel/planning';
import { planChapterCount } from '@/novel/wordBudget';
import type { StepHandler } from '../context';

export const outlineStep: StepHandler = async (ctx) => {
  const cachedId = ctx.step.input.planProposalId;
  if (typeof cachedId === 'string') {
    const cached = await selectOne<{ state: string; json: string }>('SELECT state,json FROM writing_proposals WHERE id=? AND novel_id=?', [cachedId, ctx.job.novelId]);
    if (cached?.state === 'accepted') return { outputRef: cachedId };
    if (cached?.state === 'pending') {
      if (JSON.parse(cached.json).meta.outlineReviewRequired) await reviewOutlineProposal(ctx.job.novelId, cachedId, { provider: ctx.provider, account: ctx.recordUsage, signal: ctx.signal, gate: ctx.gate, commit: ctx.commit });
      await requirePlanAccepted(cachedId);
    }
  }
  const novel = await getNovel(ctx.job.novelId);
  if (!novel) throw new Error('小说不存在');
  ctx.setMessage('AI 正在构思大纲');
  const chapterCount = planChapterCount(novel.targetChars,{docType:novel.requirements.docType});
  const spec = outlinePrompt({ premise: novel.premise, requirements: novel.requirements, targetChars: novel.targetChars, chapterCount });
  const r = await requestJson(ctx.provider, { ...spec, schema: spec.schema! }, { signal: ctx.signal, gate: ctx.gate });
  await ctx.recordUsage(r.usage);
  const id = await applyOutline(novel.id,r.value,ctx.commit, true);
  ctx.step.input = { ...ctx.step.input, planProposalId: id };
  await setStepInput(ctx.step.id, ctx.step.input);
  if (docTypeGuide(novel.requirements.docType).fiction) await reviewOutlineProposal(novel.id, id, { provider: ctx.provider, account: ctx.recordUsage, signal: ctx.signal, gate: ctx.gate, commit: ctx.commit });
  throw new AwaitingReviewError('大纲已生成，请在规划页审阅并采纳');
};
