import { z } from "zod";
import { CHARACTER_DESIGN_RULE, CHARACTER_REVIEW_RULE } from "./characterDesign";
import { PLOT_DESIGN_RULE, PLOT_GENRE_RULE, PLOT_REVIEW_RULE } from "./plotDesign";
import { storyDirectionContext } from "@/db/repos/storyOptionsRepo";
import { ModelEvidenceSchema, locateModelEvidence } from '@/llm/prompts/evidence';
import { nanoid } from "nanoid";
import {
  anchorEvidence,
  EvidenceSchema,
  ScenePlanSchema,
} from "@the-water/shared";
import { requestJson, schemaReserveTokens } from "@/llm/json";
import { estimateMessagesTokens } from "@/llm/tokens";
import { UNTRUSTED_GUARD_RULE, wrapUntrusted } from "@/llm/prompts/untrusted";
import { providersForPurposes } from "@/jobs/runner";
import { getNovelProviders } from "./service";
import { getNovel } from "@/db/repos/novelsRepo";
import {
  getChapter,
  getVersion,
  sealChapterSessions,
} from "@/db/repos/chaptersRepo";
import {
  chapterDependencies,
  listCanonEvents,
  validateCardReferences,
  invalidateMemoryOperations,
  type WritingCard,
} from "@/db/repos/writingRepo";
import {
  getStoryGraph,
  graphCas,
  loadStoryWorkspace,
  historyOperation,
} from "@/db/repos/storyGraphRepo";
import { getDb, now, writeAtomic, writeStatement, type AtomicWriter } from "@/db/db";
import { assertBudget, recordUsage } from "@/db/repos/usageRepo";
import { LLMError } from "@/llm/types";
import { readProseOnly } from './firstReading';
import { FirstReadingSchema } from '@/llm/prompts/firstReading';
import { emitJobEvent } from "@/jobs/events";

/** Real provider only. Failures remain errors; no fallback or manufactured model responses. */
export async function requestStoryJson<T>(
  novelId: string,
  instruction: string,
  source: unknown,
  schema: z.ZodType<T>,
  signal: AbortSignal,
  craftRule = `${CHARACTER_DESIGN_RULE}\n${PLOT_DESIGN_RULE}\n${PLOT_GENRE_RULE}`,
  options: { includeDirection?: boolean } = {},
) {
  await assertBudget(novelId);
  const ids = await getNovelProviders(novelId);
  const provider = (
    await providersForPurposes(
      { params: { providerIds: ids }, providerId: ids.writing ?? null },
      ["writing"],
    )
  ).writing!;
  const maxTokens = Math.min(
    10000,
    provider.caps.maxOutputTokens - (provider.caps.reasoningTokens ?? 0),
  );
  const messages = [
    {
      role: "system" as const,
      content: `你是作者掌舵的小说编辑。保留未确定信息，不编造原文依据。所有文学判断都是编辑意见，不是客观测量。只返回 JSON。\n${craftRule}\n${UNTRUSTED_GUARD_RULE}`,
    },
    {
      role: "user" as const,
      content: `${instruction}\n${wrapUntrusted("作品与作者材料", JSON.stringify(source))}\n${options.includeDirection === false ? '' : wrapUntrusted("作者采纳的故事方向（规划约束，非正文事实）", await storyDirectionContext(novelId))}`,
    },
  ];
  if (
    estimateMessagesTokens(messages, provider.caps.cjkTokenRatio) +
      schemaReserveTokens(schema, provider.caps) +
      maxTokens +
      (provider.caps.reasoningTokens ?? 0) +
      1500 >
    provider.caps.contextWindow
  )
    throw new Error("所选原文和结构超出模型窗口，请配置更大窗口的模型");
  try {
    const result = await requestJson(
      provider,
      { messages, schema, temperature: 0.4, maxTokens, label: "故事工作台" },
      { signal },
    );
    await recordUsage({
      usage: result.usage,
      purpose: "chat",
      model: provider.model,
      providerKind: provider.kind,
      providerId: provider.id,
      novelId,
    });
    return result.value;
  } catch (error) {
    if (error instanceof LLMError && error.usage)
      await recordUsage({
        usage: error.usage,
        purpose: "chat",
        model: provider.model,
        providerKind: provider.kind,
        providerId: provider.id,
        novelId,
      });
    throw error;
  }
}
export const ProseReadingSchema = z.object({
  scenes: z
    .array(
      z.object({
        existingSceneId: z.string().nullable(),
        plan: ScenePlanSchema,
        evidence: EvidenceSchema,
        interpretation: z.string().max(4000),
      }),
    )
    .max(40),
  issues: z
    .array(
      z.object({
        kind: z.enum([
          "deviation",
          "motivation",
          "knowledge",
          "thread",
          "repetition",
          "pace",
          "emotion",
        ]),
        purpose: z.string().min(1).max(4000),
        suggestion: z.string().min(1).max(4000),
        evidence: EvidenceSchema,
      }),
    )
    .max(40),
  firstReading: FirstReadingSchema.optional(),
});
type ProseReading = z.infer<typeof ProseReadingSchema>;
const ModelProseReadingSchema = ProseReadingSchema.extend({
  scenes: z.array(ProseReadingSchema.shape.scenes.element.extend({ evidence: ModelEvidenceSchema })).max(40),
  issues: z.array(ProseReadingSchema.shape.issues.element.extend({ evidence: ModelEvidenceSchema })).max(40),
});
export interface ReadingSuggestion {
  id: string;
  chapterId: string;
  versionId: string;
  contentHash: string;
  dependencyHash: string;
  graphRevision: number;
  reading: ProseReading;
}
export async function listStoryReadings(
  novelId: string,
): Promise<ReadingSuggestion[]> {
  return (
    await getDb().select<{ id: string; json: string }>(
      "SELECT id,json FROM story_suggestions WHERE novel_id=? AND kind='reading' AND state='pending' ORDER BY created_at DESC",
      [novelId],
    )
  ).map((r) => ({ id: r.id, ...JSON.parse(r.json) }));
}
export async function readStoryProse(
  novelId: string,
  chapterId: string,
  signal: AbortSignal,
  commit: AtomicWriter = writeAtomic,
) {
  await sealChapterSessions(chapterId);
  const w = await loadStoryWorkspace(novelId),
    chapter = await getChapter(chapterId);
  const version = chapter?.currentVersionId
    ? await getVersion(chapter.currentVersionId)
    : null;
  if (chapter?.novelId !== novelId || !version?.content.trim())
    throw new Error("请先保存本章正文");
  const dependencies = await chapterDependencies(novelId, chapter.chapterNo);
  await assertBudget(novelId);
  const ids = await getNovelProviders(novelId);
  const provider = (await providersForPurposes({ params: { providerIds: ids }, providerId: ids.consistency ?? ids.writing ?? null }, ['consistency'])).consistency!;
  const blind = await readProseOnly(novelId, chapter.chapterNo, version, provider, { signal });
  await recordUsage({ usage: blind.usage, purpose: 'consistency', model: provider.model, providerKind: provider.kind, providerId: provider.id, novelId });
  const plans = w.cards.filter(
    (c) => c.kind === "scene" && c.chapterId === chapterId,
  );
  const modelReading = await requestStoryJson(
    novelId,
    "提取所选章实际写出的场景，对比已确认计划，诊断动机、知情、伏笔、重复与阅读推进。existingSceneId 仅可来自所附场景；新增场景用 null。time/location 等原文未确定内容留空，引用 ID 仅来自资料。每个场景和每条诊断附逐字原文 evidence（只给 quote，使用唯一的连续逐字原文，程序计算字符位置）。不要把计划当作已发生事实。不必凑问题，确无问题可返回空 issues。文学判断说明修改目的。",
    {
      chapter,
      text: version.content,
      plans,
      characters: w.characters,
      characterIntents: w.cards.filter(c => c.kind === 'character' && c.confirmed),
      firstReading: blind.reading,
      volumes: w.cards.filter((c) => c.kind === "volume"),
      threads: w.cards.filter((c) => c.kind === "thread"),
      graph: w.graph,
      facts: await listCanonEvents(novelId, chapter.chapterNo),
    },
    ModelProseReadingSchema.superRefine((value, check) => {
      for (const key of ['scenes', 'issues'] as const) value[key].forEach((item, index) => {
        try { locateModelEvidence(version.content, item.evidence); }
        catch { check.addIssue({ code: 'custom', path: [key, index, 'evidence'], message: 'quote 必须是正文中唯一的连续逐字原文，不能引用计划或编造依据。' }); }
      });
    }),
    signal,
    `${CHARACTER_REVIEW_RULE}\n${PLOT_REVIEW_RULE}`,
  );
  const reading = ProseReadingSchema.parse({
    firstReading: blind.reading,
    scenes: modelReading.scenes.map(item => ({ ...item, evidence: locateModelEvidence(version.content, item.evidence) })),
    issues: modelReading.issues.map(item => ({ ...item, evidence: locateModelEvidence(version.content, item.evidence) })),
  });
  const assigned = new Set<string>();
  for (const s of reading.scenes) {
    s.evidence = anchorEvidence(version.content, s.evidence);
    if (
      s.existingSceneId &&
      (!plans.some((p) => p.id === s.existingSceneId) ||
        assigned.has(s.existingSceneId))
    )
      throw new Error("提取结果引用不存在或重复的场景");
    if (s.existingSceneId) assigned.add(s.existingSceneId);
    await validateCardReferences(
      novelId,
      { kind: "scene", data: s.plan },
      chapterId,
    );
  }
  for (const i of reading.issues)
    i.evidence = anchorEvidence(version.content, i.evidence);
  const id = nanoid();
  signal.throwIfAborted();
  await writeStatement(commit,
    "INSERT INTO story_suggestions(id,novel_id,kind,json,created_at) VALUES (?,?,'reading',?,?)",
    [
      id,
      novelId,
      JSON.stringify({
        chapterId,
        versionId: version.id,
        contentHash: version.contentHash,
        dependencyHash: dependencies.hash,
        graphRevision: w.revision,
        reading,
      }),
      now(),
    ],
  );
  return id;
}
/** Author may update plans from prose, or keep plans and use the diagnostics to request a rewrite. */
export async function acceptStoryReading(novelId: string, id: string, commit: AtomicWriter = writeAtomic) {
  const s = (await listStoryReadings(novelId)).find((r) => r.id === id);
  if (!s) throw new Error("提取建议不存在");
  const w = await loadStoryWorkspace(novelId),
    chapter = await getChapter(s.chapterId);
  const version = chapter?.currentVersionId
    ? await getVersion(chapter.currentVersionId)
    : null;
  if (
    !chapter ||
    !version ||
    version.id !== s.versionId ||
    version.contentHash !== s.contentHash ||
    w.revision !== s.graphRevision
  )
    throw new Error("原文或结构已变化，请重新提取");
  const deps = await chapterDependencies(novelId, chapter.chapterNo);
  if (deps.hash !== s.dependencyHash) throw new Error("计划已变化，请重新提取");
  const graph = structuredClone(w.graph),
    operations = [];
  const cards: Array<{ before: WritingCard | null; after: WritingCard }> = [];
  for (const scene of s.reading.scenes) {
    const nodeId = scene.existingSceneId ?? nanoid(),
      old = w.cards.find((c) => c.id === nodeId);
    if (graph.lockedNodeIds.includes(nodeId))
      throw new Error("提取结果涉及锁定计划，请先由作者解除锁定");
    await validateCardReferences(
      novelId,
      { kind: "scene", data: scene.plan },
      chapter.id,
    );
    cards.push({
      before: old ?? null,
      after: {
        id: nodeId,
        novelId,
        kind: "scene",
        data: scene.plan,
        chapterId: chapter.id,
        order: old?.order ?? w.cards.length + operations.length,
        revision: (old?.revision ?? 0) + 1,
        confirmed: true,
      },
    });
    if (old)
      operations.push({
        sql: "UPDATE writing_cards SET json=?,revision=revision+1,confirmed=1,updated_at=? WHERE id=? AND revision=?",
        params: [
          JSON.stringify({ kind: "scene", data: scene.plan }),
          now(),
          old.id,
          old.revision,
        ],
        expectedRows: 1,
      });
    else
      operations.push({
        sql: "INSERT INTO writing_cards(id,novel_id,kind,chapter_id,sort_order,confirmed,json,updated_at) VALUES (?,?,'scene',?,?,1,?,?)",
        params: [
          nodeId,
          novelId,
          chapter.id,
          w.cards.length + operations.length,
          JSON.stringify({ kind: "scene", data: scene.plan }),
          now(),
        ],
      });
    const matching = graph.anchors.find(
      (a) =>
        a.nodeId === nodeId &&
        a.versionId === version.id &&
        a.evidence.from === scene.evidence.from &&
        a.evidence.to === scene.evidence.to,
    );
    const anchor = {
      id: matching?.id ?? nanoid(),
      nodeId,
      chapterId: chapter.id,
      versionId: version.id,
      contentHash: version.contentHash,
      evidence: scene.evidence,
      interpretation: scene.interpretation,
      status: "confirmed" as const,
    };
    if (matching)
      graph.anchors = graph.anchors.map((a) =>
        a.id === matching.id ? anchor : a,
      );
    else graph.anchors.push(anchor);
  }
  await commit([
    deps.guard,
    ...graphCas(novelId, w.revision, graph),
    {
      sql: "UPDATE chapters SET id=id WHERE id=? AND current_version_id=?",
      params: [chapter.id, version.id],
      expectedRows: 1,
    },
    {
      sql: "UPDATE chapter_versions SET id=id WHERE id=? AND content_hash=?",
      params: [version.id, version.contentHash],
      expectedRows: 1,
    },
    ...operations,
    historyOperation(novelId, w, graph, "reading", undefined, undefined, {
      cards,
      readingId: id,
    }),
    ...invalidateMemoryOperations(novelId, chapter.chapterNo),
    {
      sql: "UPDATE story_suggestions SET state='accepted' WHERE id=? AND state='pending'",
      params: [id],
      expectedRows: 1,
    },
  ]);
  emitJobEvent({ type: "novel:storylineUpdated", novelId });
}
export async function dismissStoryReading(novelId: string, id: string, commit: AtomicWriter = writeAtomic) {
  await writeStatement(commit,
    "UPDATE story_suggestions SET state='discarded' WHERE id=? AND novel_id=? AND state='pending'",
    [id, novelId],
  );
}
export const DiscussionSchema = z.object({
  alternatives: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        choice: z.string().max(4000),
        characterEffect: z.string().max(4000),
        laterEffect: z.string().max(4000),
      }),
    )
    .min(2)
    .max(5),
});
export async function discussStory(
  novelId: string,
  question: string,
  signal: AbortSignal,
) {
  const w = await loadStoryWorkspace(novelId),
    novel = await getNovel(novelId);
  const result = await requestStoryJson(
    novelId,
    `作者问题：${question}\n提出有实质区别的可能走向，说明对人物与后续情节的影响。都是候选建议，不宣称已改作品。`,
    {
      premise: novel?.premise,
      cards: w.cards,
      graph: w.graph,
      chapters: w.chapters.map((c) => ({
        id: c.id,
        title: c.title,
        goal: c.goal,
      })),
    },
    DiscussionSchema,
    signal,
  );
  await getDb().execute(
    "INSERT INTO story_suggestions(id,novel_id,kind,json,created_at) VALUES (?,?,'discussion',?,?)",
    [nanoid(), novelId, JSON.stringify({ question, ...result }), now()],
  );
  return result;
}
export async function listStoryDiscussions(novelId: string) {
  return (
    await getDb().select<{ id: string; json: string }>(
      "SELECT id,json FROM story_suggestions WHERE novel_id=? AND kind='discussion' ORDER BY created_at DESC LIMIT 20",
      [novelId],
    )
  ).map((r) => ({
    id: r.id,
    ...(JSON.parse(r.json) as { question: string } & z.infer<
      typeof DiscussionSchema
    >),
  }));
}
export async function suggestStoryVoice(novelId: string, signal: AbortSignal) {
  const { graph } = await getStoryGraph(novelId);
  const samples = graph.anchors.filter((a) =>
    graph.preferences.sampleAnchorIds.includes(a.id),
  );
  if (!samples.length) throw new Error("请先选择作者指定的原文样稿");
  const schema = z.object({
    narration: z.string().max(12000),
    dialogue: z.string().max(12000),
    forbidden: z.array(z.string().min(1).max(200)).max(100),
  });
  return requestStoryJson(
    novelId,
    "仅依据作者指定样稿整理叙述声音与对白偏好；禁用表达只有作者明示才能填写，否则空数组。结果待作者确认。",
    {
      samples,
      authorPreferences: graph.preferences.confirmed ? graph.preferences : null,
    },
    schema,
    signal,
  );
}
