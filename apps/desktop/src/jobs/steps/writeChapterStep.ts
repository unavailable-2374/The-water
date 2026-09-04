import { countZh } from '@the-water/shared';
import { createVersion, findVersionByStep, setChapterStatus } from '@/db/repos/chaptersRepo';
import { completeWithRetry } from '@/llm/complete';
import { writeChapterPrompt } from '@/llm/prompts/writeChapter';
import { maxTokensForChapter, shouldSplitChapter } from '@/novel/wordBudget';
import { emitJobEvent } from '../events';
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
  const contextUserText = await buildChapterContextText(env, ctx.provider, maxTokens);
  const base = { chapterNo: chapter.chapterNo, requirements: novel.requirements, contextUserText, targetChars: target, caps: ctx.provider.caps, style: styleExtrasOf(env) };

  let text: string;
  let usage = { inputTokens: 0, outputTokens: 0 };
  if (shouldSplitChapter(target)) {
    const first = writeChapterPrompt({ ...base, half: 'first' });
    const r1 = await completeWithRetry(ctx.provider, { messages: first.messages, maxTokens: first.maxTokens, temperature: first.temperature, signal: ctx.signal }, { onDelta: (_d, acc) => ctx.onDelta(acc) });
    const second = writeChapterPrompt({ ...base, half: 'second', firstHalfText: r1.text });
    const r2 = await completeWithRetry(ctx.provider, { messages: second.messages, maxTokens: second.maxTokens, temperature: second.temperature, signal: ctx.signal }, { onDelta: (_d, acc) => ctx.onDelta(r1.text + '\n\n' + acc) });
    text = `${r1.text.trim()}\n\n${r2.text.trim()}`;
    usage = { inputTokens: r1.usage.inputTokens + r2.usage.inputTokens, outputTokens: r1.usage.outputTokens + r2.usage.outputTokens };
  } else {
    const spec = writeChapterPrompt(base);
    const r = await completeWithRetry(ctx.provider, { messages: spec.messages, maxTokens: spec.maxTokens, temperature: spec.temperature, signal: ctx.signal }, { onDelta: (_d, acc) => ctx.onDelta(acc) });
    text = r.text.trim();
    usage = r.usage;
  }
  if (countZh(text) < 50) throw new Error('模型返回的正文过短');
  const version = await createVersion({ chapterId: chapter.id, content: text, source: 'generated', storylineSnapshotId: env.snapshotId, jobStepId: ctx.step.id, model: ctx.provider.model, usage });
  emitJobEvent({ type: 'chapter:versionCreated', novelId: novel.id, chapterId: chapter.id, versionId: version.id });
  return { outputRef: version.id };
};
