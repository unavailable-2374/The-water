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
  const novel = await getNovel(ctx.job.novelId);
  if (!novel) throw new Error('小说不存在');
  ctx.setMessage('AI 正在构思大纲');
  const chapterCount = planChapterCount(novel.targetChars);
  const spec = outlinePrompt({ premise: novel.premise, requirements: novel.requirements, targetChars: novel.targetChars, chapterCount });
  const r = await requestJson(ctx.provider, { ...spec, schema: spec.schema! }, { signal: ctx.signal, gate: ctx.gate });
  await ctx.recordUsage(r.usage);
  await applyOutline(novel.id, r.value);
  return { outputRef: null };
};
