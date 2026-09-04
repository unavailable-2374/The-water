import { countZh } from '@the-water/shared';
import { createVersion, findVersionByStep } from '@/db/repos/chaptersRepo';
import { completeWithRetry } from '@/llm/complete';
import { lengthAdjustPrompt } from '@/llm/prompts/lengthAdjust';
import { renderChapterPlan } from '@/llm/prompts/context';
import { lengthAction } from '@/novel/wordBudget';
import { emitJobEvent } from '../events';
import type { StepHandler } from '../context';
import { currentVersionOf, loadChapterEnv, styleExtrasOf } from './common';

const MAX_EXPAND_PASSES = 2;

export const adjustLengthStep: StepHandler = async (ctx) => {
  const env = await loadChapterEnv(ctx);
  const { chapter, novel, doc } = env;
  const existing = await findVersionByStep(chapter.id, ctx.step.id);
  if (existing) return { outputRef: existing.id };
  let version = await currentVersionOf(chapter);
  if (!version) throw new Error('章节尚无正文');
  const target = chapter.targetChars || 3000;
  const plan = doc.chapters.find((p) => p.chapterNo === chapter.chapterNo);
  const planText = plan ? renderChapterPlan(plan, doc) : '';
  const forced = (ctx.step.input as { force?: 'expand' | 'trim' }).force ?? null;
  let passes = 0;
  let lastRef: string | null = null;
  while (passes < MAX_EXPAND_PASSES) {
    const actual = countZh(version.content);
    const action = forced && passes === 0 ? forced : lengthAction(actual, target);
    if (action === 'ok') break;
    if (action === 'trim' && passes >= 1) break;
    if (forced && passes >= 1) break;
    ctx.setMessage(`第 ${chapter.chapterNo} 章 ${action === 'expand' ? '扩写' : '精简'}中（${actual} → ${target} 字）`);
    const spec = lengthAdjustPrompt({ chapterNo: chapter.chapterNo, requirements: novel.requirements, chapterText: version.content, actual, target, mode: action, chapterPlanText: planText, caps: ctx.provider.caps, style: styleExtrasOf(env) });
    const r = await completeWithRetry(ctx.provider, { messages: spec.messages, maxTokens: spec.maxTokens, temperature: spec.temperature, signal: ctx.signal }, { onDelta: (_d, acc) => ctx.onDelta(acc) });
    const text = r.text.trim();
    if (countZh(text) < 50) break;
    // never accept a result that moved further from the target (unless the user forced it)
    if (!forced && Math.abs(countZh(text) - target) >= Math.abs(actual - target)) break;
    version = await createVersion({ chapterId: chapter.id, content: text, source: action === 'expand' ? 'topup' : 'trim', summary: version.summary, storylineSnapshotId: env.snapshotId, jobStepId: ctx.step.id, model: ctx.provider.model, usage: r.usage });
    emitJobEvent({ type: 'chapter:versionCreated', novelId: novel.id, chapterId: chapter.id, versionId: version.id });
    lastRef = version.id;
    passes++;
  }
  return { outputRef: lastRef ?? version.id };
};
