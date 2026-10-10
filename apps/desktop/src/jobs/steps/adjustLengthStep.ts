import { docTypeGuide } from '@/novel/docTypes';
import { countZh } from '@the-water/shared';
import { createVersion, findVersionByStep } from '@/db/repos/chaptersRepo';
import { completeWithRetry } from '@/llm/complete';
import { lengthAdjustPrompt } from '@/llm/prompts/lengthAdjust';
import { renderChapterPlan } from '@/llm/prompts/context';
import { lengthAction } from '@/novel/wordBudget';
import { emitJobEvent } from '../events';
import { joinResumed, resumePrefix, withResumeSeed } from '../resume';
import { AwaitingReviewError } from '../awaitingReview';
import type { StepHandler } from '../context';
import { currentVersionOf, loadChapterEnv, passKey, styleExtrasOf } from './common';

export const MAX_EXPAND_PASSES = 2;

/**
 * 调整字数。这一步最多产出两个版本（扩写两轮 / 扩写后再精简），
 * 所以**每个 pass 用自己的幂等键** `${stepId}#${pass}`（§2.1 第 7 条）：
 * 崩在两轮之间时，第一轮的版本能被认出来直接复用，只重跑第二轮。
 * 老数据里第一轮版本用的是裸 stepId，这里也一并认（见 adoptedRef）。
 */
export const adjustLengthStep: StepHandler = async (ctx) => {
  const env = await loadChapterEnv(ctx);
  const { chapter, novel, doc } = env;
  let version = await currentVersionOf(chapter);
  if (!version) throw new Error('章节尚无正文');
  const target = chapter.targetChars || 3000;
  const plan = doc.chapters.find((p) => p.chapterNo === chapter.chapterNo);
  const planText = plan ? renderChapterPlan(plan, doc) : '';
  const forced = (ctx.step.input as { force?: 'expand' | 'trim' }).force ?? null;
  // Fiction length follows dramatic completeness, never a quota in either direction.
  if (!forced && docTypeGuide(novel.requirements.docType).fiction) return {outputRef:version.id};
  // An author may have corrected an exhausted adjustment while it waited.
  // Keep that current draft instead of restoring cached, oversized AI passes.
  const initialAction = lengthAction(countZh(version.content),target);
  if (!forced && (initialAction==='ok' || initialAction==='expand' && docTypeGuide(novel.requirements.docType).fiction)) return {outputRef:version.id};
  let seed = resumePrefix(ctx.takeResumeSeed());
  let passes = 0;
  let lastRef: string | null = null;

  while (passes < MAX_EXPAND_PASSES) {
    // 这一轮以前跑过吗？跑过就直接采用，不再调模型。
    const done = (await findVersionByStep(chapter.id, passKey(ctx.step.id, passes)))
      ?? (passes === 0 ? await findVersionByStep(chapter.id, ctx.step.id) : null);
    if (done) {
      version = done;
      lastRef = done.id;
      passes++;
      seed = '';
      continue;
    }
    const actual = countZh(version.content);
    const action = forced && passes === 0 ? forced : lengthAction(actual, target);
    if (action === 'ok') break;
    // Fiction content is assessed by narrative review, not padded to a quota. Explicit author expansion remains available.
    if (!forced && action === 'expand' && docTypeGuide(novel.requirements.docType).fiction) break;
    if (forced && passes >= 1) break;
    ctx.setMessage(`第 ${chapter.chapterNo} 章 ${action === 'expand' ? '扩写' : '精简'}中（${actual} → ${target} 字）`);
    const spec = lengthAdjustPrompt({ chapterNo: chapter.chapterNo, requirements: novel.requirements, chapterText: version.content, actual, target, mode: action, chapterPlanText: planText, caps: ctx.provider.caps, style: styleExtrasOf(env) });
    const { messages } = withResumeSeed(spec.messages, seed);
    const r = await completeWithRetry(
      ctx.provider,
      { messages, maxTokens: spec.maxTokens, temperature: spec.temperature, signal: ctx.signal },
      { requireComplete: true, gate: ctx.gate, onDelta: (_d, acc) => ctx.onDelta(joinResumed(seed, acc)) },
    );
    const text = joinResumed(seed, r.text).trim();
    seed = '';
    await ctx.recordUsage(r.usage);
    if (countZh(text) < 50) break;
    // never accept a result that moved further from the target (unless the user forced it)
    if (!forced && Math.abs(countZh(text) - target) >= Math.abs(actual - target)) break;
    version = await createVersion({ commit: ctx.commit, chapterId: chapter.id, expectedWorkingVersionId: version.id, expectedWorkingHash: version.contentHash, content: text, source: action === 'expand' ? 'topup' : 'trim', summary: version.summary, storylineSnapshotId: env.snapshotId, jobStepId: passKey(ctx.step.id, passes), model: ctx.provider.model, usage: r.usage });
    emitJobEvent({ type: 'chapter:versionCreated', novelId: novel.id, chapterId: chapter.id, versionId: version.id });
    lastRef = version.id;
    passes++;
  }
  if (!forced && lengthAction(countZh(version.content),target)==='trim')
    throw new AwaitingReviewError(`第 ${chapter.chapterNo} 章精简后仍超出字数范围（当前 ${countZh(version.content)} 字，目标 ${target} 字）。请在正文中精简后继续；已保留完整工作稿。`,{kind:'chapter'});
  return { outputRef: lastRef ?? version.id };
};
