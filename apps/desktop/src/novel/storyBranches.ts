import { writeAtomic, writeStatement, type AtomicWriter } from '@/db/db';
import { z } from "zod";
import { nanoid } from "nanoid";
import {
  anchorEvidence,
  anchorState,
  canonicalJson,
  EvidenceSchema,
  ScenePlanSchema,
  StoryGraphSchema,
  sha256Hex,
} from "@the-water/shared";
import { getDb, now } from "@/db/db";
import {
  getChapter,
  getVersion,
  createVersion,
  sealChapterSessions,
} from "@/db/repos/chaptersRepo";
import {
  assertStoryTextEdit,
  graphCas,
  loadStoryWorkspace,
  validateGraph,
  historyOperation,
} from "@/db/repos/storyGraphRepo";
import {
  chapterDependencies,
  validateCardReferences,
} from "@/db/repos/writingRepo";
import { requestStoryJson } from "./storyIntelligence";
import { emitJobEvent } from "@/jobs/events";
import { ModelEvidenceSchema, locateModelEvidence } from '@/llm/prompts/evidence';

export const StoryBranchSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(200),
  revision: z.number().int(),
  state: z.enum(["draft", "merged", "reverted"]),
  nodeId: z.string(),
  chapterId: z.string(),
  baseCardRevision: z.number().int(),
  baseGraphRevision: z.number().int(),
  baseVersionId: z.string().nullable(),
  baseHash: z.string(),
  baseText: z.string(),
  basePlan: ScenePlanSchema,
  dependencyHash: z.string(),
  graph: StoryGraphSchema,
  plan: ScenePlanSchema,
  range: z.object({ from: z.number().int(), to: z.number().int() }).nullable(),
  sample: z.string(),
  facts: z
    .array(z.object({ text: z.string(), evidence: EvidenceSchema }))
    .max(100),
});
export type StoryBranch = z.infer<typeof StoryBranchSchema>;
/** Validate quotations before requestJson finishes, so its bounded repair can correct them. */
export const BranchSampleSchema = z.object({
  sample: z.string().min(1).max(60000),
  facts: z.array(z.object({
    text: z.string().min(1).max(4000),
    evidence: ModelEvidenceSchema,
  })).max(100),
}).superRefine((value, ctx) => {
  value.facts.forEach((fact, index) => {
    try {
      locateModelEvidence(value.sample, fact.evidence);
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["facts", index, "evidence"],
        message: "依据必须逐字引用 sample 中唯一的连续原文；请扩展重复引文的上下文，不能改写或编造引文。",
      });
    }
  });
});
export async function listStoryBranches(
  novelId: string,
): Promise<StoryBranch[]> {
  return (
    await getDb().select<{ json: string }>(
      "SELECT json FROM story_branches WHERE novel_id=? ORDER BY updated_at DESC",
      [novelId],
    )
  ).map((r) => StoryBranchSchema.parse(JSON.parse(r.json)));
}
export async function createStoryBranch(
  novelId: string,
  nodeId: string,
  name: string,
  commit: AtomicWriter = writeAtomic,
) {
  const w = await loadStoryWorkspace(novelId),
    card = w.cards.find((c) => c.id === nodeId);
  if (!card || card.kind !== "scene" || !card.chapterId)
    throw new Error("请选择已关联章节的场景");
  await sealChapterSessions(card.chapterId);
  const chapter = w.chapters.find((c) => c.id === card.chapterId)!;
  const version = chapter.currentVersionId
    ? await getVersion(chapter.currentVersionId)
    : null;
  const anchors = w.graph.anchors.filter(
    (a) =>
      a.nodeId === nodeId &&
      a.chapterId === chapter.id &&
      a.status === "confirmed" &&
      anchorState(a, version) === "current",
  );
  const range =
    anchors.length === 1
      ? { from: anchors[0]!.evidence.from, to: anchors[0]!.evidence.to }
      : !version?.content ||
          w.cards.filter(
            (c) => c.kind === "scene" && c.chapterId === chapter.id,
          ).length === 1
        ? { from: 0, to: version?.content.length ?? 0 }
        : null;
  const value = StoryBranchSchema.parse({
    id: nanoid(),
    name,
    revision: 0,
    state: "draft",
    nodeId,
    chapterId: card.chapterId,
    baseCardRevision: card.revision,
    baseGraphRevision: w.revision,
    baseVersionId: version?.id ?? null,
    baseHash: version?.contentHash ?? "",
    baseText: version?.content ?? "",
    basePlan: card.data,
    plan: card.data,
    graph: w.graph,
    dependencyHash: (await chapterDependencies(novelId, chapter.chapterNo))
      .hash,
    range,
    sample: range ? (version?.content ?? "").slice(range.from, range.to) : "",
    facts: [],
  });
  await writeStatement(commit,
    "INSERT INTO story_branches(id,novel_id,name,json,updated_at) VALUES (?,?,?,?,?)",
    [value.id, novelId, name, JSON.stringify(value), now()],
  );
  return value;
}
export async function saveStoryBranch(
  novelId: string,
  before: StoryBranch,
  patch: Pick<StoryBranch, "plan" | "sample" | "graph" | "name"> & {
    facts?: StoryBranch["facts"];
  },
  commit: AtomicWriter = writeAtomic,
) {
  if (before.state !== "draft") throw new Error("方案已合并，请创建新方案");
  const value = StoryBranchSchema.parse({
    ...before,
    ...patch,
    facts: patch.facts ?? (patch.sample === before.sample ? before.facts : []),
    revision: before.revision + 1,
  });
  for (const f of value.facts)
    f.evidence = anchorEvidence(value.sample, f.evidence);
  await commit([
    {
      sql: "UPDATE story_branches SET name=?,revision=?,json=?,updated_at=? WHERE id=? AND novel_id=? AND revision=?",
      params: [
        value.name,
        value.revision,
        JSON.stringify(value),
        now(),
        before.id,
        novelId,
        before.revision,
      ],
      expectedRows: 1,
    },
  ]);
  return value;
}
export async function generateBranchSample(
  novelId: string,
  branch: StoryBranch,
  instruction: string,
  signal: AbortSignal,
  commit: AtomicWriter = writeAtomic,
) {
  const w = await loadStoryWorkspace(novelId);
  const result = await requestStoryJson(
    novelId,
    `在独立剧情方案中写此场景样稿。作者意图：${instruction}。只依据本方案资料，不改变主作品。facts 只提取本次样稿实际写出的事实并附 evidence.quote：样稿中唯一的连续逐字原文，不要计算字符位置。`,
    {
      plan: branch.plan,
      graph: branch.graph,
      original: branch.range
        ? branch.baseText.slice(branch.range.from, branch.range.to)
        : "",
      characters: w.characters,
      context: w.cards.filter((c) => c.kind !== "scene"),
    },
    BranchSampleSchema,
    signal,
  );
  return saveStoryBranch(novelId, branch, {
    name: branch.name,
    plan: branch.plan,
    graph: branch.graph,
    ...result,
    facts: result.facts.map(fact => ({ ...fact, evidence: locateModelEvidence(result.sample, fact.evidence) })),
  }, commit);
}
export async function branchConflicts(
  novelId: string,
  branch: StoryBranch,
): Promise<string[]> {
  const w = await loadStoryWorkspace(novelId),
    card = w.cards.find((c) => c.id === branch.nodeId);
  const chapter = await getChapter(branch.chapterId),
    version = chapter?.currentVersionId
      ? await getVersion(chapter.currentVersionId)
      : null;
  const conflicts: string[] = [];
  if (branch.state !== "draft") conflicts.push("merged");
  if (w.revision !== branch.baseGraphRevision) conflicts.push("structure");
  if (card?.revision !== branch.baseCardRevision) conflicts.push("plan");
  if (
    version?.id !== (branch.baseVersionId ?? undefined) ||
    (version?.contentHash ?? "") !== branch.baseHash
  )
    conflicts.push("text");
  if (
    !chapter ||
    chapter.novelId !== novelId ||
    (await chapterDependencies(novelId, chapter.chapterNo)).hash !==
      branch.dependencyHash
  )
    conflicts.push("dependencies");
  if (w.graph.lockedNodeIds.includes(branch.nodeId)) conflicts.push("locked");
  if (!branch.range && branch.sample) conflicts.push("anchor");
  return conflicts;
}
export async function mergeStoryBranch(novelId: string, branch: StoryBranch, commit: AtomicWriter = writeAtomic) {
  const conflicts = await branchConflicts(novelId, branch);
  if (conflicts.length)
    throw new Error(`方案合并冲突：${conflicts.join("、")}`);
  await validateGraph(novelId, branch.graph);
  await validateCardReferences(
    novelId,
    { kind: "scene", data: branch.plan },
    branch.chapterId,
  );
  const chapter = (await getChapter(branch.chapterId))!,
    deps = await chapterDependencies(novelId, chapter.chapterNo);
  const workspace = await loadStoryWorkspace(novelId);
  const graph = workspace.graph;
  const before = workspace.cards.find((c) => c.id === branch.nodeId)!;
  if (before.kind !== "scene") throw new Error("方案场景不存在");
  if (
    canonicalJson(graph.lockedNodeIds) !==
      canonicalJson(branch.graph.lockedNodeIds) ||
    canonicalJson(graph.lockedAnchors) !==
      canonicalJson(branch.graph.lockedAnchors)
  )
    throw new Error("方案不能改变主作品的锁定权限");
  const next = branch.range
    ? branch.baseText.slice(0, branch.range.from) +
      branch.sample +
      branch.baseText.slice(branch.range.to)
    : branch.baseText;
  if (branch.range)
    await assertStoryTextEdit(
      novelId,
      branch.chapterId,
      branch.baseText,
      branch.range.from,
      branch.range.to,
    );
  const operations = [
    deps.guard,
    ...graphCas(novelId, branch.baseGraphRevision, branch.graph),
    historyOperation(
      novelId,
      workspace,
      branch.graph,
      "branch",
      before,
      { ...before, data: branch.plan, revision: before.revision + 1 },
      {
        branch: { id: branch.id, revision: branch.revision + 1 },
        ...(next !== branch.baseText
          ? {
              prose: {
                chapterId: branch.chapterId,
                beforeText: branch.baseText,
                afterHash: await sha256Hex(next),
              },
            }
          : {}),
      },
    ),
    {
      sql: "UPDATE writing_cards SET json=?,revision=revision+1,updated_at=? WHERE id=? AND novel_id=? AND revision=?",
      params: [
        JSON.stringify({ kind: "scene", data: branch.plan }),
        now(),
        branch.nodeId,
        novelId,
        branch.baseCardRevision,
      ],
      expectedRows: 1,
    },
    {
      sql: "UPDATE story_branches SET json=?,revision=revision+1,updated_at=? WHERE id=? AND novel_id=? AND revision=?",
      params: [
        JSON.stringify({
          ...branch,
          state: "merged",
          revision: branch.revision + 1,
        }),
        now(),
        branch.id,
        novelId,
        branch.revision,
      ],
      expectedRows: 1,
    },
  ];
  // Branch facts stay in the branch archive. A normal chapter review establishes live canon.
  if (next !== branch.baseText)
    await createVersion({
      commit,
      chapterId: branch.chapterId,
      content: next,
      source: "user_edit",
      expectedWorkingVersionId: branch.baseVersionId,
      expectedWorkingHash: branch.baseVersionId ? branch.baseHash : null,
      atomicTail: operations,
    });
  else await commit(operations);
  emitJobEvent({ type: "novel:storylineUpdated", novelId });
}
