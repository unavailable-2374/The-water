import { nanoid } from "nanoid";
import {
  canonicalJson,
  sha256Hex,
  WritingMandateSchema,
  anchorState,
  type WritingMandate,
} from "@the-water/shared";
import { getDb, now, type AtomicWriter, type AtomicOperation } from "@/db/db";
import {
  getChapter,
  getVersion,
  createVersion,
  sealChapterSessions,
} from "@/db/repos/chaptersRepo";
import {
  assertStoryTextEdit,
  getStoryGraph,
  loadStoryWorkspace,
} from "@/db/repos/storyGraphRepo";
import { chapterDependencies } from "@/db/repos/writingRepo";
import {
  assistantRequest,
  acceptTextProposal,
  listTextProposals,
} from "./assistant";
import { emitJobEvent } from "@/jobs/events";

export async function listMandates(novelId: string): Promise<WritingMandate[]> {
  return (
    await getDb().select<{ json: string }>(
      "SELECT json FROM story_mandates WHERE novel_id=? ORDER BY updated_at DESC",
      [novelId],
    )
  ).map((r) => WritingMandateSchema.parse(JSON.parse(r.json)));
}
async function storeMandate(
  novelId: string,
  value: WritingMandate,
  previous?: WritingMandate,
  commit?: AtomicWriter,
) {
  const json = JSON.stringify(WritingMandateSchema.parse(value));
  if (!previous) {
    const op={sql:"INSERT INTO story_mandates(id,novel_id,json,updated_at) VALUES (?,?,?,?)",params:[value.id,novelId,json,now()]};
    await (commit ?? (ops=>getDb().atomic(ops)))([op]);
  }
  else
    await getDb().atomic([
      {
        sql: "UPDATE story_mandates SET json=?,updated_at=? WHERE id=? AND novel_id=? AND json=?",
        params: [json, now(), value.id, novelId, JSON.stringify(previous)],
        expectedRows: 1,
      },
    ]);
  emitJobEvent({ type: "novel:storylineUpdated", novelId });
}
export async function createMandate(
  novelId: string,
  nodeIds: string[],
  rules: { must: string; may: string; mustNot: string },
  commit?: AtomicWriter,
): Promise<WritingMandate> {
  const w = await loadStoryWorkspace(novelId);
  const selected = [...new Set(nodeIds)].map((id) =>
    w.nodes.find((n) => n.id === id),
  );
  if (
    !selected.length ||
    selected.some((n) => !n || n.kind !== "scene" || !n.chapterId)
  )
    throw new Error("请选择已关联章节的场景");
  const targets: WritingMandate["targets"] = [];
  const guards:AtomicOperation[]=[];
  for (const chapterId of new Set(selected.map((n) => n!.chapterId!))) {
    await sealChapterSessions(chapterId);
    const chapter = w.chapters.find((c) => c.id === chapterId)!;
    const version = chapter.currentVersionId
      ? await getVersion(chapter.currentVersionId)
      : null;
    const text = version?.content ?? "";
    const dependency=await chapterDependencies(novelId,chapter.chapterNo);
    guards.push(dependency.guard,{sql:"UPDATE chapters SET id=id WHERE id=? AND current_version_id IS ?",params:[chapter.id,version?.id??null],expectedRows:1});
    const ids = selected
      .filter((n) => n!.chapterId === chapterId)
      .map((n) => n!.id);
    if (w.cards.some((c) => ids.includes(c.id) && !c.confirmed))
      throw new Error("请先确认授权场景计划");
    const all = w.nodes.filter(
      (n) => n.kind === "scene" && n.chapterId === chapterId,
    );
    const ranges =
      all.every((n) => ids.includes(n.id)) || !text
        ? [{ from: 0, to: text.length, nodeIds: ids }]
        : ids.map((id) => {
            const anchors = w.graph.anchors.filter(
              (a) =>
                a.nodeId === id &&
                a.chapterId === chapterId &&
                a.status === "confirmed" &&
                anchorState(a, version) === "current",
            );
            if (anchors.length !== 1)
              throw new Error(
                "局部场景需要唯一且有效的正文关联；请先关联原文或明确选择整章所有场景",
              );
            return {
              from: anchors[0]!.evidence.from,
              to: anchors[0]!.evidence.to,
              nodeIds: [id],
            };
          });
    for (const range of ranges) {
      await assertStoryTextEdit(novelId, chapterId, text, range.from, range.to);
      targets.push({
        ...range,
        chapterId,
        versionId: version?.id ?? null,
        contentHash: await sha256Hex(text),
        dependencyHash: dependency.hash,
        proposalId: null,
        state: "pending",
      });
    }
  }
  const mandate = WritingMandateSchema.parse({
    id: nanoid(),
    nodeIds: selected.map((n) => n!.id),
    ...rules,
    graphRevision: w.revision,
    state: "ready",
    targets,
    error: null,
  });
  await storeMandate(novelId, mandate, undefined, ops=>(commit ?? (ops=>getDb().atomic(ops)))([...guards,...ops]));
  return mandate;
}
const active = new Set<string>();
/** Resume only unfinished targets. Generated proposals are durable before the next target starts. */
export async function runMandate(
  novelId: string,
  id: string,
  signal: AbortSignal,
  onDelta: (text: string) => void,
) {
  if (active.has(id)) throw new Error("此委托正在执行");
  const initial = (await listMandates(novelId)).find((m) => m.id === id);
  if (
    !initial ||
    initial.state === "cancelled" ||
    initial.state === "completed"
  )
    throw new Error("委托已结束");
  active.add(id);
  let current = initial;
  const update = async (patch: Partial<WritingMandate>) => {
    const next = { ...current, ...patch };
    await storeMandate(novelId, next, current);
    current = next;
  };
  try {
    await update({ state: "running", error: null });
    for (let i = 0; i < current.targets.length; i++) {
      if (signal.aborted) throw new Error("作者已中断委托，可恢复未完成范围");
      const target = current.targets[i]!;
      if (target.state === "done") continue;
      const w = await loadStoryWorkspace(novelId);
      if (w.revision !== current.graphRevision)
        throw new Error("结构已变化，请重新预演并授权");
      const chapter = await getChapter(target.chapterId);
      const version = chapter?.currentVersionId
        ? await getVersion(chapter.currentVersionId)
        : null;
      if (
        !chapter ||
        (await sha256Hex(version?.content ?? "")) !== target.contentHash ||
        (await chapterDependencies(novelId, chapter.chapterNo)).hash !==
          target.dependencyHash
      )
        throw new Error("授权时的正文或计划已变化，请重新预演并授权");
      // Recover a proposal saved immediately before an interruption, without another model call.
      const prior = (await listTextProposals(target.chapterId)).find(
        (p) =>
          p.mandateId === id && p.from === target.from && p.to === target.to,
      );
      const proposal =
        prior ??
        (
          await assistantRequest({
            novelId,
            chapterId: chapter.id,
            versionId: version?.id ?? null,
            text: version?.content ?? "",
            from: target.from,
            to: target.to,
            operation: "rewrite",
            sourceIds: target.nodeIds,
            mandateId: id,
            instruction: `仅为授权场景生成候选正文。必须发生：${current.must}\n允许发挥：${current.may}\n不能改动：${current.mustNot}\n遇到语义冲突不要擅改计划，在正文之外的变更需另行由作者决定。仅输出本次选区替换正文。`,
            signal,
            onDelta,
          })
        ).proposal;
      if (!proposal) throw new Error("模型没有返回候选");
      const targets = current.targets.map((t, j) =>
        j === i ? { ...t, proposalId: proposal.id, state: "done" as const } : t,
      );
      await update({ targets });
    }
    await update({ state: "completed" });
  } catch (error) {
    await update({
      state: "paused",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    active.delete(id);
  }
}
export async function cancelMandate(novelId: string, id: string) {
  if (active.has(id)) throw new Error("请先中断正在执行的委托");
  const value = (await listMandates(novelId)).find((m) => m.id === id);
  if (value)
    await storeMandate(novelId, { ...value, state: "cancelled" }, value);
}
export async function applyStoryProposal(
  novelId: string,
  chapterId: string,
  proposalId: string,
) {
  const chapter = await getChapter(chapterId),
    proposal = (await listTextProposals(chapterId)).find(
      (p) => p.id === proposalId,
    );
  if (!chapter || chapter.novelId !== novelId || !proposal)
    throw new Error("候选不存在");
  const version = chapter.currentVersionId
    ? await getVersion(chapter.currentVersionId)
    : null;
  const content = await acceptTextProposal(proposal, version?.content ?? "");
  const graph = await getStoryGraph(novelId),
    dependencies = await chapterDependencies(novelId, chapter.chapterNo);
  if (
    proposal.graphHash &&
    proposal.graphHash !== (await sha256Hex(canonicalJson(graph.graph)))
  )
    throw new Error("结构已变化");
  await createVersion({
    chapterId,
    content,
    source: "user_edit",
    expectedWorkingVersionId: version?.id ?? null,
    expectedWorkingHash: version?.contentHash,
    acceptProposalId: proposalId,
    atomicTail: [
      dependencies.guard,
      {
        sql: "UPDATE novels SET id=id WHERE id=? AND COALESCE((SELECT revision FROM story_graphs WHERE novel_id=?),0)=?",
        params: [novelId, novelId, graph.revision],
        expectedRows: 1,
      },
    ],
  });
  emitJobEvent({ type: "novel:storylineUpdated", novelId });
}
