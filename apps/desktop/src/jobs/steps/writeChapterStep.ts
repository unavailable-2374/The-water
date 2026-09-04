import { countZh } from '@the-water/shared';
import { createVersion, findVersionByStep, setChapterStatus } from '@/db/repos/chaptersRepo';
import { completeWithRetry } from '@/llm/complete';
import { withContextDowngrade } from '@/llm/contextBudget';
import { writeChapterPrompt } from '@/llm/prompts/writeChapter';
import { maxTokensForChapter, shouldSplitChapter } from '@/novel/wordBudget';
import type { Usage } from '@/llm/types';
import { emitJobEvent } from '../events';
import { joinResumed, resumePrefix, withResumeSeed } from '../resume';
import type { StepHandler } from '../context';
import { buildChapterContextText, loadChapterEnv, styleExtrasOf } from './common';

export const writeChapterStep: StepHandler = async (ctx) => {
  const env = await loadChapterEnv(ctx);
  const { chapter, novel } = env;
  const existing = await findVersionByStep(chapter.id, ctx.step.id);
  if (existing) return { outputRef: existing.id };

  await setChapterStatus(chapter.id, 'generating');
  ctx.setMessage(`正在撰写第 ${chapter.chapterNo} 章《${chapter.title}》`);
  const target = chapter.targetChars || 3000;
  const maxTokens = maxTokensForChapter(target, ctx.provider.caps);
  const split = shouldSplitChapter(target);
  // 拆半章时上一次的半成品无法判断断在第一半还是第二半，所以只在不拆章时续写。
  const seed = split ? '' : resumePrefix(ctx.takeResumeSeed());
  if (seed) ctx.setMessage(`正在接着上次中断处继续写第 ${chapter.chapterNo} 章（已有 ${countZh(seed)} 字）`);

  const { text, usage } = await withContextDowngrade<{ text: string; usage: Usage }>(
    async (scale) => {
      const contextUserText = await buildChapterContextText(env, ctx.provider, maxTokens, { scale });
      const base = { chapterNo: chapter.chapterNo, requirements: novel.requirements, contextUserText, targetChars: target, caps: ctx.provider.caps, style: styleExtrasOf(env) };
      if (split) {
        const first = writeChapterPrompt({ ...base, half: 'first' });
        const r1 = await completeWithRetry(ctx.provider, { messages: first.messages, maxTokens: first.maxTokens, temperature: first.temperature, signal: ctx.signal }, { gate: ctx.gate, onDelta: (_d, acc) => ctx.onDelta(acc) });
        const second = writeChapterPrompt({ ...base, half: 'second', firstHalfText: r1.text });
        const r2 = await completeWithRetry(ctx.provider, { messages: second.messages, maxTokens: second.maxTokens, temperature: second.temperature, signal: ctx.signal }, { gate: ctx.gate, onDelta: (_d, acc) => ctx.onDelta(r1.text + '\n\n' + acc) });
        return {
          text: `${r1.text.trim()}\n\n${r2.text.trim()}`,
          usage: { inputTokens: r1.usage.inputTokens + r2.usage.inputTokens, outputTokens: r1.usage.outputTokens + r2.usage.outputTokens },
        };
      }
      const spec = writeChapterPrompt(base);
      const { messages } = withResumeSeed(spec.messages, seed);
      const r = await completeWithRetry(ctx.provider, { messages, maxTokens: spec.maxTokens, temperature: spec.temperature, signal: ctx.signal }, { gate: ctx.gate, onDelta: (_d, acc) => ctx.onDelta(joinResumed(seed, acc)) });
      return { text: joinResumed(seed, r.text).trim(), usage: r.usage };
    },
    { onDowngrade: ({ nextScale }) => ctx.setMessage(`上下文超出模型窗口，已缩减到 ${Math.round(nextScale * 100)}% 重试第 ${chapter.chapterNo} 章`) },
  );

  if (countZh(text) < 50) throw new Error('模型返回的正文过短');
  await ctx.recordUsage(usage);
  const version = await createVersion({ chapterId: chapter.id, content: text, source: 'generated', storylineSnapshotId: env.snapshotId, jobStepId: ctx.step.id, model: ctx.provider.model, usage });
  emitJobEvent({ type: 'chapter:versionCreated', novelId: novel.id, chapterId: chapter.id, versionId: version.id });
  return { outputRef: version.id };
};
