import { nanoid } from 'nanoid';
import { storyDirectionContext } from '@/db/repos/storyOptionsRepo';
import {
  canonicalJson,
  emptyBible,
  sha256Hex,
  TextProposalSchema,
  type TextProposal,
  WritingMandateSchema,
} from '@the-water/shared';
import { getDb, now } from '@/db/db';
import {
  createVersion,
  getVersion,
  getChapter,
  listChapters,
  sealChapterSessions,
} from '@/db/repos/chaptersRepo';
import {
  appendMessage,
  createConversation,
  listConversations,
  listMessages,
} from '@/db/repos/conversationsRepo';
import { listWritingCards, chapterDependencies } from '@/db/repos/writingRepo';
import { providersForPurposes } from '@/jobs/runner';
import { getNovelProviders } from '@/novel/service';
import { getNovel } from '@/db/repos/novelsRepo';
import { buildStorylineDoc, listCharacters, listSettings } from '@/db/repos/storylineRepo';
import { bibleBeforeChapter } from '@/db/repos/bibleRepo';
import { getDocument, getPageText } from '@/db/repos/documentsRepo';
import { buildChapterContextText } from '@/jobs/steps/common';
import { effectivePrices, getUsdToCnyRate, recordUsage } from '@/db/repos/usageRepo';
import { costOfUsage, matchPrice } from '@/novel/pricing';
import { completeWithRetry } from '@/llm/complete';
import { LLMError } from '@/llm/types';
import { estimateMessagesTokens } from '@/llm/tokens';
import { wrapUntrusted, UNTRUSTED_GUARD_RULE } from '@/llm/prompts/untrusted';
import { CHARACTER_DESIGN_RULE } from './characterDesign';
import { PLOT_DESIGN_RULE, PLOT_GENRE_RULE } from './plotDesign';
import { docTypeGuide } from './docTypes';
import { applyTextProposal } from './textProposals';
import { assertStoryTextEdit, getStoryGraph } from '@/db/repos/storyGraphRepo';

export async function assistantRequest(input: {
  novelId: string;
  chapterId: string;
  versionId: string | null;
  text: string;
  from: number;
  to: number;
  operation: TextProposal['operation'] | 'discuss';
  instruction: string;
  sourceIds: string[];
  mandateId?: string;
  signal: AbortSignal;
  onDelta: (text: string) => void;
}): Promise<{ answer: string; proposal?: TextProposal }> {
  const { provider, messages, from, to, references, maxTokens, graphHash } = await prepareAssistantRequest(input);
  const conversation =
    (await listConversations({ novelId: input.novelId, kind: 'novel_assist' })).find(
      (c) => c.chapterId === input.chapterId,
    ) ??
    (await createConversation({
      kind: 'novel_assist',
      novelId: input.novelId,
      chapterId: input.chapterId,
      providerId: provider.id,
    }));
  let versionId = input.versionId;
  if (input.operation !== 'discuss') {
    const version = versionId ? await getVersion(versionId) : null;
    if (!version || version.content !== input.text)
      versionId = (
        await createVersion({
          chapterId: input.chapterId,
          content: input.text,
          source: 'user_edit',
          expectedWorkingVersionId: input.versionId,
          expectedWorkingHash: version?.contentHash,
        })
      ).id;
    await sealChapterSessions(input.chapterId);
  }
  await appendMessage({
    conversationId: conversation.id,
    role: 'user',
    content: input.instruction,
    context: { selectedText: input.text.slice(from, to) },
  });
  const chapter = await getChapter(input.chapterId);
  if (!chapter) throw new Error('章节不存在');
  const dependencies = await chapterDependencies(input.novelId, chapter.chapterNo);
  const r = await completeWithRetry(
    provider,
    { messages, maxTokens, temperature: 0.7, signal: input.signal, binding: {
      operationId: `${conversation.id}:${input.operation}:${from}:${to}`,
      candidateVersionId: versionId, contentHash: await sha256Hex(input.text), dependencyHash: dependencies.hash,
    } },
    { requireComplete: true, onDelta: (_d, text) => input.onDelta(text) },
  ).catch(async (error) => {
    if (error instanceof LLMError && error.usage)
      await recordUsage({
        usage: error.usage,
        purpose: 'chat',
        model: provider.model,
        providerKind: provider.kind,
        providerId: provider.id,
        novelId: input.novelId,
        conversationId: conversation.id,
      });
    throw error;
  });
  await appendMessage({
    conversationId: conversation.id,
    role: 'assistant',
    content: r.text,
    model: provider.model,
    usage: r.usage,
  });
  if (input.operation === 'discuss') return { answer: r.text };
  const proposal = TextProposalSchema.parse({
    id: nanoid(),
    chapterId: input.chapterId,
    baseVersionId: versionId,
    baseHash: await sha256Hex(input.text),
    operation: input.operation,
    from,
    to,
    original: input.text.slice(from, to),
    replacement: r.text,
    sourceIds: input.sourceIds,
    mandateId: input.mandateId,
    graphHash,
    dependencyHash: dependencies.hash,
    sourceHashes: await Promise.all(
      references.map(async (r) => ({ id: r.id, hash: await sha256Hex(canonicalJson(r)) })),
    ),
  });
  await getDb().execute(
    "INSERT INTO writing_proposals(id,novel_id,chapter_id,kind,json,created_at) VALUES (?,?,?,'text',?,?)",
    [proposal.id, input.novelId, input.chapterId, JSON.stringify(proposal), now()],
  );
  return { answer: r.text, proposal };
}
export async function listTextProposals(chapterId: string): Promise<TextProposal[]> {
  const rows = await getDb().select<{ json: string }>(
    "SELECT json FROM writing_proposals WHERE chapter_id=? AND kind='text' AND state IN ('pending','conflict') ORDER BY created_at",
    [chapterId],
  );
  return rows.map((r) => TextProposalSchema.parse(JSON.parse(r.json)));
}
export async function assistantHistory(novelId: string, chapterId: string) {
  const conversation = (await listConversations({ novelId, kind: 'novel_assist' })).find(
    (c) => c.chapterId === chapterId,
  );
  return conversation ? listMessages(conversation.id) : [];
}
/** Validate and return the edit for the editor's transaction/undo stack. Autosave persists it. */
export async function acceptTextProposal(proposal: TextProposal, current: string): Promise<string> {
  const base = await getVersion(proposal.baseVersionId);
  if (!base) throw new Error('建议的基础版本已删除');
  try {
    const chapter = await getChapter(proposal.chapterId);
    if (!chapter) throw new Error('章节不存在');
    if (proposal.graphHash && proposal.graphHash !== await sha256Hex(canonicalJson((await getStoryGraph(chapter.novelId)).graph))) throw new Error('故事结构或授权约束已变化，请重新生成候选');
    if (proposal.dependencyHash && proposal.dependencyHash !== (await chapterDependencies(chapter.novelId, chapter.chapterNo)).hash) throw new Error('写作依据已变化，请重新生成候选');
    const refs = await resolveAssistantReferences(chapter.novelId, proposal.sourceIds);
    for (const source of proposal.sourceHashes ?? []) {
      const ref = refs.find((r) => r.id === source.id);
      if (!ref || (await sha256Hex(canonicalJson(ref))) !== source.hash)
        throw new Error('引用资料已变化，请重新生成候选');
    }
    const next = await applyTextProposal(proposal, base.content, current);
    const { graph } = await getStoryGraph(chapter.novelId);
    for (const phrase of graph.preferences.confirmed ? graph.preferences.forbidden : []) if (proposal.replacement.includes(phrase)) throw new Error(`候选包含作者禁用表达：${phrase}`);
    // Check the actual rebased edit, not obsolete offsets in the original version.
    let start = 0, tail = 0;
    while (start < Math.min(next.length, current.length) && next[start] === current[start]) start++;
    while (tail < next.length - start && tail < current.length - start && next.at(-1-tail) === current.at(-1-tail)) tail++;
    await assertStoryTextEdit(chapter.novelId, chapter.id, current, start, current.length-tail);
    return next;
  } catch (e) {
    await getDb().execute("UPDATE writing_proposals SET state='conflict' WHERE id=?", [proposal.id]);
    throw e;
  }
}

export interface AssistantReference {
  id: string;
  title: string;
  content: unknown;
}
export async function listAssistantReferences(novelId: string): Promise<AssistantReference[]> {
  const [cards, characters, settings] = await Promise.all([
    listWritingCards(novelId, { confirmed: true }),
    listCharacters(novelId),
    listSettings(novelId),
  ]);
  return [
    ...cards.map((c) => ({
      id: c.id,
      title: 'title' in c.data ? c.data.title : c.kind === 'brief' ? c.data.premise : c.data.goal,
      content: c,
    })),
    ...characters.map((c) => ({ id: c.id, title: c.name, content: c })),
    ...settings.map((c) => ({ id: c.id, title: c.name, content: c })),
  ];
}
async function resolveAssistantReferences(novelId: string, ids: string[]) {
  const all = await listAssistantReferences(novelId),
    references: AssistantReference[] = [];
  for (const id of ids) {
    const reference = all.find((r) => r.id === id);
    if (reference) {
      references.push(reference);
      continue;
    }
    const page = /^pdf:([^:]+):(\d+)$/.exec(id);
    if (!page) throw new Error('引用资料已变化，请重新选择');
    const doc = await getDocument(page[1]!);
    const pageNo = Number(page[2]);
    if (!doc || pageNo < 1 || pageNo > doc.pageCount) throw new Error('引用资料页不存在');
    const text = await getPageText(doc.id, pageNo);
    if (text === null) throw new Error('资料页尚未提取文本，请先在书架中打开并完成索引');
    references.push({
      id,
      title: `${doc.title} · ${pageNo}`,
      content: { documentId: doc.id, fileHash: doc.fileSha256, pageNo, text },
    });
  }
  return references;
}
type AssistantInput = Parameters<typeof assistantRequest>[0];
async function prepareAssistantRequest(input: AssistantInput) {
  const providerIds = await getNovelProviders(input.novelId);
  const provider = (
    await providersForPurposes({ params: { providerIds }, providerId: providerIds.writing ?? null }, [
      'writing',
    ])
  ).writing!;
  const references = await resolveAssistantReferences(input.novelId, input.sourceIds);
  const chapter = await getChapter(input.chapterId),
    novel = await getNovel(input.novelId);
  if (!chapter || !novel || chapter.novelId !== novel.id) throw new Error('章节不存在');
  if (input.mandateId) {
    const rows = await getDb().select<{json:string}>('SELECT json FROM story_mandates WHERE id=? AND novel_id=?',[input.mandateId,novel.id]);
    const mandate = rows[0] ? WritingMandateSchema.parse(JSON.parse(rows[0].json)) : null;
    const target = mandate?.targets.find(t=>t.chapterId===chapter.id && t.from===input.from && t.to===input.to && t.state==='pending');
    if (!mandate || mandate.state!=='running' || !target || target.contentHash!==await sha256Hex(input.text) || target.dependencyHash!==(await chapterDependencies(novel.id,chapter.chapterNo)).hash || canonicalJson([...target.nodeIds].sort())!==canonicalJson([...input.sourceIds].sort()) || mandate.graphRevision!==(await getStoryGraph(novel.id)).revision) throw new Error('请求超出当前授权范围或授权依据已变化');
  }
  const chapters = await listChapters(novel.id);
  if (
    input.operation !== 'discuss' &&
    chapters.some(
      (c) => c.chapterNo < chapter.chapterNo && c.committedVersionId && c.memoryStatus !== 'valid',
    )
  )
    throw new Error('前文正式记忆需要先重建；仍可讨论构思');
  const doc = await buildStorylineDoc(novel.id, novel.premise, novel.meta.themes),
    bible = (await bibleBeforeChapter(novel.id, chapter.chapterNo))?.bible ?? emptyBible();
  const maxTokens = Math.min(4096, provider.caps.maxOutputTokens - (provider.caps.reasoningTokens ?? 0));
  const context = await buildChapterContextText(
    { novel, chapter, doc, bible, chapters, snapshotId: null },
    provider,
    maxTokens,
    { reserved: input.text.length * provider.caps.cjkTokenRatio },
  );
  const conversation = (await listConversations({ novelId: novel.id, kind: 'novel_assist' })).find(
    (c) => c.chapterId === chapter.id,
  );
  const history = conversation ? await listMessages(conversation.id) : [];
  const from = Math.max(0, Math.min(input.from, input.text.length)),
    to = input.operation === 'continue' ? from : Math.max(from, Math.min(input.to, input.text.length));
  const { graph } = await getStoryGraph(novel.id);
  if (input.operation !== 'discuss') await assertStoryTextEdit(novel.id, chapter.id, input.text, from, to);
  const messages = [
    {
      role: 'system' as const,
      content: `你是作者的小说创作助手。讨论只提供建议，不宣称已修改作品。操作=${input.operation}。discuss 用自然语言讨论；其余操作只返回待插入或替换选区的正文，不输出解释或 Markdown。使用已确认规划和正文记忆，讨论和工作稿不是正式事实。不得改变已确认计划。\n${docTypeGuide(novel.requirements.docType).fiction ? `${CHARACTER_DESIGN_RULE}\n${PLOT_DESIGN_RULE}\n${PLOT_GENRE_RULE}` : ""}\n${UNTRUSTED_GUARD_RULE}`,
    },
    ...history.slice(-12).map((m) => ({ role: m.role, content: m.content })),
    {
      role: 'user' as const,
      content: `${context}\n${wrapUntrusted('作者采纳的故事方向（规划约束，非正文事实）', await storyDirectionContext(novel.id))}\n${input.instruction}\n${wrapUntrusted('作者确认的时间、因果与知情计划（不是正文事实）', JSON.stringify({ nodes: graph.nodes, relations: graph.relations.filter(r => r.status === 'confirmed'), secrets: graph.secrets, growth: graph.growth }))}\n${wrapUntrusted('作者确认的创作偏好', JSON.stringify(graph.preferences.confirmed ? graph.preferences : {}))}\n${wrapUntrusted('显式引用资料', JSON.stringify(references))}\n选区：${from}–${to}\n${wrapUntrusted('当前工作稿（不是正式事实）', input.text)}`,
    },
  ];
  if (
    estimateMessagesTokens(messages, provider.caps.cjkTokenRatio) +
      maxTokens +
      (provider.caps.reasoningTokens ?? 0) +
      1500 >
    provider.caps.contextWindow
  )
    throw new Error('必需资料与正文超出模型窗口，请使用更大窗口的模型');
  return { provider, messages, from, to, references, maxTokens, graphHash: await sha256Hex(canonicalJson(graph)) };
}
export async function previewAssistantRequest(input: AssistantInput) {
  const { provider, messages, maxTokens } = await prepareAssistantRequest(input);
  const prices = await effectivePrices(),
    rate = await getUsdToCnyRate(),
    price = matchPrice(prices, provider.model, provider.kind);
  const usage = {
    inputTokens: estimateMessagesTokens(messages, provider.caps.cjkTokenRatio),
    outputTokens: maxTokens + (provider.caps.reasoningTokens ?? 0),
  };
  return {
    usage,
    costCny: costOfUsage(usage, price, rate),
    priced: !!price,
    writingModel: provider.model,
    auxiliaryModel: '',
    minimumCalls: 1,
    maximumCalls: 1,
  };
}
