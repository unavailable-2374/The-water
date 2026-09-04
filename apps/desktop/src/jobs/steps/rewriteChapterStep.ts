import { countZh } from '@the-water/shared';
import { createVersion, findVersionByStep, setChapterStatus } from '@/db/repos/chaptersRepo';
import { completeWithRetry } from '@/llm/complete';
import { rewriteChapterPrompt } from '@/llm/prompts/rewriteChapter';
import { maxTokensForChapter } from '@/novel/wordBudget';
import { applyNameReplacements } from '@/novel/storyline/affected';
import { emitJobEvent } from '../events';
import type { StepHandler } from '../context';
import { buildChapterContextText, currentVersionOf, loadChapterEnv, styleExtrasOf } from './common';

interface RewriteInput { mode?: 'revise' | 'rewrite'; instructions?: string[]; replacements?: Array<{ from: string; to: string }> }

export const rewriteChapterStep: StepHandler = async (ctx) => {
  const env = await loadChapterEnv(ctx);
  const { chapter, novel } = env;
  const existing = await findVersionByStep(chapter.id, ctx.step.id);
  if (existing) return { outputRef: existing.id };
  const old = await currentVersionOf(chapter);
  if (!old) throw new Error('章节尚无正文，无法改写');
  const input = ctx.step.input as RewriteInput;
  const mode = input.mode ?? 'revise';
  await setChapterStatus(chapter.id, 'generating');
  ctx.setMessage(`正在${mode === 'rewrite' ? '重写' : '修改'}第 ${chapter.chapterNo} 章《${chapter.title}》`);
  const target = chapter.targetChars || countZh(old.content) || 3000;
  const maxTokens = maxTokensForChapter(target, ctx.provider.caps);
  const contextUserText = await buildChapterContextText(env, ctx.provider, maxTokens);
  const oldText = input.replacements?.length ? applyNameReplacements(old.content, input.replacements) : old.content;
  const spec = rewriteChapterPrompt({ chapterNo: chapter.chapterNo, requirements: novel.requirements, contextUserText, oldText, instructions: input.instructions ?? [], mode, targetChars: target, caps: ctx.provider.caps, style: styleExtrasOf(env) });
  const r = await completeWithRetry(ctx.provider, { messages: spec.messages, maxTokens: spec.maxTokens, temperature: spec.temperature, signal: ctx.signal }, { onDelta: (_d, acc) => ctx.onDelta(acc) });
  const text = r.text.trim();
  if (countZh(text) < 50) throw new Error('模型返回的正文过短');
  const version = await createVersion({ chapterId: chapter.id, content: text, source: 'rewritten', storylineSnapshotId: env.snapshotId, jobStepId: ctx.step.id, model: ctx.provider.model, usage: r.usage });
  emitJobEvent({ type: 'chapter:versionCreated', novelId: novel.id, chapterId: chapter.id, versionId: version.id });
  return { outputRef: version.id };
};

/** Deterministic name replacement (no LLM). */
export const nameReplaceStep: StepHandler = async (ctx) => {
  const env = await loadChapterEnv(ctx);
  const { chapter, novel } = env;
  const existing = await findVersionByStep(chapter.id, ctx.step.id);
  if (existing) return { outputRef: existing.id };
  const old = await currentVersionOf(chapter);
  if (!old) return { outputRef: null };
  const reps = ((ctx.step.input as RewriteInput).replacements ?? []).filter((r) => r.from && r.to && r.from !== r.to);
  const text = applyNameReplacements(old.content, reps);
  if (text === old.content) return { outputRef: old.id };
  const version = await createVersion({ chapterId: chapter.id, content: text, source: 'user_edit', summary: applyNameReplacements(old.summary, reps), storylineSnapshotId: env.snapshotId, jobStepId: ctx.step.id, status: chapter.status === 'final' ? 'final' : 'draft' });
  emitJobEvent({ type: 'chapter:versionCreated', novelId: novel.id, chapterId: chapter.id, versionId: version.id });
  return { outputRef: version.id };
};
