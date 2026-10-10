import { sha256Hex } from '@the-water/shared';
import { listChapters, getVersion } from '@/db/repos/chaptersRepo';
import { firstReadingPrompt, locateFirstReading, type ReadingSource } from '@/llm/prompts/firstReading';
import { requestJson, schemaReserveTokens } from '@/llm/json';
import { estimateMessagesTokens } from '@/llm/tokens';
import type { LLMProvider } from '@/llm/types';
import type { RateGate } from '@/llm/retry';
import { AwaitingReviewError } from '@/jobs/awaitingReview';

export async function readProseOnly(novelId: string, chapterNo: number, current: { id: string; content: string }, provider: LLMProvider, options: { signal: AbortSignal; gate?: RateGate }) {
  const sources: ReadingSource[] = [];
  for (const chapter of await listChapters(novelId)) {
    if (chapter.chapterNo >= chapterNo) continue;
    if (!chapter.committedVersionId) throw new AwaitingReviewError(`首次阅读需要第 ${chapter.chapterNo} 章已提交的正文，不能用大纲代替`);
    const v = await getVersion(chapter.committedVersionId);
    if (!v) throw new AwaitingReviewError(`首次阅读缺少第 ${chapter.chapterNo} 章的正文版本`);
    sources.push({ chapterNo: chapter.chapterNo, versionId: v.id, contentHash: await sha256Hex(v.content), text: v.content });
  }
  sources.push({ chapterNo, versionId: current.id, contentHash: await sha256Hex(current.content), text: current.content });
  const spec = firstReadingPrompt(sources);
  if (estimateMessagesTokens(spec.messages, provider.caps.cjkTokenRatio) + schemaReserveTokens(spec.schema!, provider.caps) + spec.maxTokens! + (provider.caps.reasoningTokens ?? 0) + 1500 > provider.caps.contextWindow)
    throw new AwaitingReviewError('截至本章的完整正文超出首次阅读模型窗口，请配置更大窗口模型；未截断前文或用摘要替代');
  const result = await requestJson(provider, { ...spec, schema: spec.schema! }, options);
  return { reading: locateFirstReading(result.value, sources), usage: result.usage };
}
