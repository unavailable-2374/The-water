import { writeAtomic, type AtomicWriter } from '../db';
import { nanoid } from "nanoid";
import {
  StoryGraphSchema,
  emptyStoryGraph,
  validateStoryGraphTopology,
  canonicalJson,
  verifyEvidence,
  type StoryGraph,
  type StoryNode,
  WritingCardDataSchema,
  type StoryAnchor,
  BeatSchema,
  type Beat,
} from "@the-water/shared";
import { getDb, now, selectOne, type AtomicOperation } from "../db";
import {
  getChapter,
  getVersion,
  listChapters,
  sealChapterSessions,
  createVersion,
} from "./chaptersRepo";
import {
  listArcs,
  listBeats,
  listCharacters,
  listSettings,
} from "./storylineRepo";
import {
  invalidateMemoryOperations,
  listWritingCards,
  validateCardReferences,
  type WritingCard,
} from "./writingRepo";
import { emitJobEvent } from "@/jobs/events";

export interface GraphRecord {
  revision: number;
  graph: StoryGraph;
}
export async function getStoryGraph(novelId: string): Promise<GraphRecord> {
  const row = await selectOne<{ revision: number; json: string }>(
    "SELECT revision,json FROM story_graphs WHERE novel_id=?",
    [novelId],
  );
  return row
    ? {
        revision: row.revision,
        graph: StoryGraphSchema.parse(JSON.parse(row.json)),
      }
    : { revision: 0, graph: emptyStoryGraph() };
}
export async function loadStoryWorkspace(novelId: string) {
  const [record, cards, chapters, beats, arcs, characters, settings] =
    await Promise.all([
      getStoryGraph(novelId),
      listWritingCards(novelId),
      listChapters(novelId),
      listBeats(novelId),
      listArcs(novelId),
      listCharacters(novelId),
      listSettings(novelId),
    ]);
  const byId = new Map(chapters.map((c) => [c.id, c]));
  const metadata = new Map(record.graph.nodes.map((n) => [n.id, n]));
  const nodes: StoryNode[] = [
    ...cards.flatMap((c) =>
      c.kind === "scene"
        ? [
            {
              id: c.id,
              title: c.data.title,
              kind: "scene" as const,
              chapterId: c.chapterId,
              chapterNo: c.chapterId
                ? (byId.get(c.chapterId)?.chapterNo ?? null)
                : null,
              order: c.order,
              characterIds: c.data.characterIds,
              volumeId: c.data.volumeId,
              arcId: metadata.get(c.id)?.arcId ?? null,
            },
          ]
        : [],
    ),
    ...beats.map((b) => ({
      id: b.id,
      title: b.title,
      kind: "beat" as const,
      chapterId:
        chapters.find((c) => c.beatIds.includes(b.id))?.id ??
        chapters.find((c) => c.chapterNo === b.chapterNo)?.id ??
        null,
      chapterNo:
        chapters.find((c) => c.beatIds.includes(b.id))?.chapterNo ??
        b.chapterNo,
      order: b.order,
      characterIds: b.characterIds,
      volumeId: null,
      arcId: metadata.get(b.id)?.arcId ?? b.arcId,
    })),
  ];
  return {
    ...record,
    cards,
    chapters,
    beats,
    arcs,
    characters,
    settings,
    nodes,
  };
}
export type StoryWorkspace = Awaited<ReturnType<typeof loadStoryWorkspace>>;

export async function validateGraph(novelId: string, graph: StoryGraph) {
  const w = await loadStoryWorkspace(novelId);
  validateStoryGraphTopology(graph, {
    nodes: w.nodes,
    characters: w.characters.map((c) => c.id),
    arcs: w.arcs.map((c) => c.id),
    available: [
      ...w.cards,
      ...w.beats,
      ...w.characters,
      ...w.arcs,
      ...w.settings,
    ].map((c) => c.id),
  });
  const versions = new Map<string, ReturnType<typeof getVersion>>();
  const chapters = new Map(w.chapters.map((c) => [c.id, Promise.resolve(c)]));
  for (const a of [...graph.anchors, ...graph.lockedAnchors]) {
    let source = versions.get(a.versionId);
    if (!source) {
      source = getVersion(a.versionId);
      versions.set(a.versionId, source);
    }
    const [chapter, version] = await Promise.all([
      chapters.get(a.chapterId) ?? getChapter(a.chapterId),
      source,
    ]);
    if (
      chapter?.novelId !== novelId ||
      !version ||
      version.chapterId !== a.chapterId ||
      version.contentHash !== a.contentHash ||
      !verifyEvidence(version.content, a.evidence)
    )
      throw new Error("原文关联的版本、哈希或引句无效");
  }
}
export function graphCas(
  novelId: string,
  revision: number,
  graph: StoryGraph,
): AtomicOperation[] {
  return [
    {
      sql: "INSERT OR IGNORE INTO story_graphs(novel_id,revision,json,updated_at) VALUES (?,0,?,?)",
      params: [novelId, JSON.stringify(emptyStoryGraph()), now()],
    },
    {
      sql: "UPDATE story_graphs SET revision=revision+1,json=?,updated_at=? WHERE novel_id=? AND revision=?",
      params: [JSON.stringify(graph), now(), novelId, revision],
      expectedRows: 1,
    },
  ];
}
interface StoryChangeEffects {
  cards?: Array<{ before: WritingCard | null; after: WritingCard }>;
  readingId?: string;
  branch?: { id: string; revision: number };
  prose?: { chapterId: string; beforeText: string; afterHash: string };
}
export function historyOperation(
  novelId: string,
  base: GraphRecord,
  graph: StoryGraph,
  label: string,
  before?: WritingCard,
  after?: WritingCard,
  effects: StoryChangeEffects = {},
): AtomicOperation {
  return {
    sql: "INSERT INTO story_changes(id,novel_id,revision,label,before_json,after_json,card_before,card_after,effects_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    params: [
      nanoid(),
      novelId,
      base.revision + 1,
      label,
      JSON.stringify(base.graph),
      JSON.stringify(graph),
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      JSON.stringify(effects),
      now(),
    ],
  };
}
export async function saveStoryGraph(
  novelId: string,
  expectedRevision: number,
  input: StoryGraph,
  label: string,
  commit: AtomicWriter = writeAtomic,
) {
  const graph = StoryGraphSchema.parse(input),
    base = await getStoryGraph(novelId);
  if (base.revision !== expectedRevision)
    throw new Error("故事结构已变化，请刷新后重新预演");
  await validateGraph(novelId, graph);
  await commit([
    ...graphCas(novelId, expectedRevision, graph),
    historyOperation(novelId, base, graph, label),
  ]);
  emitJobEvent({ type: "novel:storylineUpdated", novelId });
}
/** Scene edits and their history are one transaction. Existing forms see the same card. */
export async function editStoryScene(
  novelId: string,
  expectedRevision: number,
  before: WritingCard,
  data: WritingCard["data"],
  chapterId: string | null,
  order: number,
) {
  if (before.kind !== "scene") throw new Error("请选择场景");
  const base = await getStoryGraph(novelId);
  if (base.revision !== expectedRevision)
    throw new Error("故事结构已变化，请刷新后重新预演");
  if (base.graph.lockedNodeIds.includes(before.id))
    throw new Error("场景已锁定，请先由作者解除锁定");
  if (!chapterId || (await getChapter(chapterId))?.novelId !== novelId)
    throw new Error("场景必须关联本作品的章节");
  const value = WritingCardDataSchema.parse({ kind: "scene", data });
  if (!Number.isSafeInteger(order) || order < 0)
    throw new Error("场景顺序必须为非负整数");
  if (before.confirmed) await validateCardReferences(novelId, value, chapterId);
  const after = {
    ...before,
    ...value,
    chapterId,
    order,
    revision: before.revision + 1,
  } as WritingCard;
  await getDb().atomic([
    ...graphCas(novelId, expectedRevision, base.graph),
    {
      sql: "UPDATE writing_cards SET json=?,chapter_id=?,sort_order=?,revision=revision+1,updated_at=? WHERE id=? AND novel_id=? AND revision=?",
      params: [
        JSON.stringify(value),
        chapterId,
        order,
        now(),
        before.id,
        novelId,
        before.revision,
      ],
      expectedRows: 1,
    },
    historyOperation(novelId, base, base.graph, "scene", before, after),
    ...invalidateMemoryOperations(novelId, 1),
  ]);
  emitJobEvent({ type: "novel:storylineUpdated", novelId });
}
export async function listStoryChanges(novelId: string) {
  return getDb().select<{
    id: string;
    revision: number;
    label: string;
    undone: number;
  }>(
    "SELECT id,revision,label,undone FROM story_changes WHERE novel_id=? ORDER BY revision DESC LIMIT 50",
    [novelId],
  );
}
function beatChange(
  novelId: string,
  before: Beat,
  after: Beat,
): AtomicOperation {
  const values = (b: Beat) => [
    b.title,
    b.summary,
    b.arcId,
    b.chapterNo,
    JSON.stringify(b.characterIds),
    JSON.stringify(b.settingIds),
    b.order,
  ];
  return {
    sql: "UPDATE storyline_beats SET title=?,summary=?,arc_id=?,chapter_no=?,character_ids=?,setting_ids=?,sort_order=?,updated_at=? WHERE id=? AND novel_id=? AND title=? AND summary=? AND arc_id IS ? AND chapter_no IS ? AND character_ids=? AND setting_ids=? AND sort_order=?",
    params: [...values(after), now(), before.id, novelId, ...values(before)],
    expectedRows: 1,
  };
}
export async function editStoryBeat(
  novelId: string,
  expectedRevision: number,
  before: Beat,
  input: Beat,
) {
  const after = BeatSchema.parse(input),
    base = await getStoryGraph(novelId);
  if (after.id !== before.id || base.revision !== expectedRevision)
    throw new Error("故事结构已变化，请刷新后重新预演");
  await getDb().atomic([
    ...graphCas(novelId, expectedRevision, base.graph),
    beatChange(novelId, before, after),
    {
      sql: "INSERT INTO story_changes(id,novel_id,revision,label,before_json,after_json,beat_before,beat_after,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      params: [
        nanoid(),
        novelId,
        expectedRevision + 1,
        "beat",
        JSON.stringify(base.graph),
        JSON.stringify(base.graph),
        JSON.stringify(before),
        JSON.stringify(after),
        now(),
      ],
    },
  ]);
  emitJobEvent({ type: "novel:storylineUpdated", novelId });
}
export async function undoStoryChange(novelId: string, changeId: string, commit: AtomicWriter = writeAtomic) {
  const change = await selectOne<{
    revision: number;
    before_json: string;
    after_json: string;
    card_before: string | null;
    card_after: string | null;
    beat_before: string | null;
    beat_after: string | null;
    effects_json: string;
  }>("SELECT * FROM story_changes WHERE id=? AND novel_id=? AND undone=0", [
    changeId,
    novelId,
  ]);
  const base = await getStoryGraph(novelId);
  const latest = (await listStoryChanges(novelId)).find((c) => !c.undone);
  if (
    !change ||
    latest?.id !== changeId ||
    canonicalJson(base.graph) !== canonicalJson(JSON.parse(change.after_json))
  )
    throw new Error("后续结构已变化，无法覆盖撤销");
  const graph = StoryGraphSchema.parse(JSON.parse(change.before_json));
  await validateGraph(novelId, graph);
  const ops: AtomicOperation[] = [...graphCas(novelId, base.revision, graph)];
  const effects = JSON.parse(change.effects_json) as StoryChangeEffects;
  if (change.beat_before && change.beat_after)
    ops.push(
      beatChange(
        novelId,
        BeatSchema.parse(JSON.parse(change.beat_after)),
        BeatSchema.parse(JSON.parse(change.beat_before)),
      ),
    );
  const changedCards = effects.cards ?? [];
  if (change.card_before && change.card_after)
    changedCards.push({
      before: JSON.parse(change.card_before) as WritingCard,
      after: JSON.parse(change.card_after) as WritingCard,
    });
  const allCards = await listWritingCards(novelId);
  for (const { before, after } of changedCards) {
    const current = allCards.find((c) => c.id === after.id);
    if (
      !current ||
      canonicalJson({ ...current, revision: 0 }) !==
        canonicalJson({ ...after, revision: 0 })
    )
      throw new Error("场景已被其他编辑修改，无法覆盖撤销");
    if (!before) {
      if (
        allCards.some(
          (c) =>
            c.kind === "scene" &&
            c.data.dependencyIds.includes(after.id) &&
            !changedCards.some((x) => x.after.id === c.id),
        )
      )
        throw new Error("新增场景已被其他计划引用，无法覆盖撤销");
      ops.push({
        sql: "DELETE FROM writing_cards WHERE id=? AND novel_id=? AND revision=?",
        params: [current.id, novelId, current.revision],
        expectedRows: 1,
      });
    } else
      ops.push({
        sql: "UPDATE writing_cards SET json=?,chapter_id=?,sort_order=?,confirmed=?,revision=revision+1,updated_at=? WHERE id=? AND novel_id=? AND revision=?",
        params: [
          JSON.stringify({ kind: before.kind, data: before.data }),
          before.chapterId,
          before.order,
          before.confirmed ? 1 : 0,
          now(),
          before.id,
          novelId,
          current.revision,
        ],
        expectedRows: 1,
      });
    ops.push(...invalidateMemoryOperations(novelId, 1));
  }
  ops.push({
    sql: "UPDATE story_changes SET undone=1 WHERE id=? AND undone=0",
    params: [changeId],
    expectedRows: 1,
  });
  if (effects.readingId)
    ops.push({
      sql: "UPDATE story_suggestions SET state='reverted' WHERE id=? AND novel_id=? AND state='accepted'",
      params: [effects.readingId, novelId],
      expectedRows: 1,
    });
  if (effects.branch)
    ops.push({
      sql: "UPDATE story_branches SET json=json_set(json,'$.state','reverted','$.revision',revision+1),revision=revision+1,updated_at=? WHERE id=? AND novel_id=? AND revision=?",
      params: [now(), effects.branch.id, novelId, effects.branch.revision],
      expectedRows: 1,
    });
  if (effects.prose) {
    const chapter = await getChapter(effects.prose.chapterId);
    const version = chapter?.currentVersionId
      ? await getVersion(chapter.currentVersionId)
      : null;
    if (
      chapter?.novelId !== novelId ||
      !version ||
      version.contentHash !== effects.prose.afterHash
    )
      throw new Error("合并后的正文已变化，无法覆盖撤销");
    await createVersion({
      chapterId: chapter.id,
      content: effects.prose.beforeText,
      source: "user_edit",
      expectedWorkingVersionId: version.id,
      expectedWorkingHash: version.contentHash,
      atomicTail: ops,
      commit,
    });
  } else await commit(ops);
  emitJobEvent({ type: "novel:storylineUpdated", novelId });
}
/** Locks also cover existing writing entry points; unresolved anchors fail closed. */
export async function assertStoryTextEdit(
  novelId: string,
  chapterId: string,
  text: string,
  from: number,
  to: number,
) {
  const { graph } = await getStoryGraph(novelId);
  const cards = await listWritingCards(novelId, { chapterId });
  const chapter = await getChapter(chapterId);
  const locked = [
    ...cards.filter((c) => graph.lockedNodeIds.includes(c.id)).map((c) => c.id),
    ...(chapter?.beatIds.filter((id) => graph.lockedNodeIds.includes(id)) ??
      []),
  ];
  const anchors = [
    ...graph.lockedAnchors.filter((a) => a.chapterId === chapterId),
  ];
  for (const id of locked) {
    const ranges = graph.anchors.filter(
      (a) =>
        a.nodeId === id &&
        a.chapterId === chapterId &&
        a.status === "confirmed",
    );
    if (!ranges.length)
      throw new Error(
        "此章包含尚未定位原文的锁定场景；请先由作者关联原文或解除锁定",
      );
    anchors.push(...ranges);
  }
  for (const a of anchors) {
    if (!verifyEvidence(text, a.evidence))
      throw new Error("锁定原文位置已变化，请先重新关联");
    if (
      from === to
        ? from > a.evidence.from && from < a.evidence.to
        : from < a.evidence.to && to > a.evidence.from
    )
      throw new Error("授权范围覆盖锁定原文");
  }
}
export async function makeStoryAnchor(
  nodeId: string,
  chapterId: string,
  from: number,
  to: number,
  interpretation = "",
): Promise<StoryAnchor> {
  await sealChapterSessions(chapterId);
  const chapter = await getChapter(chapterId),
    version = chapter?.currentVersionId
      ? await getVersion(chapter.currentVersionId)
      : null;
  if (!version || from < 0 || to <= from || to > version.content.length)
    throw new Error("请在已保存的正文中选择有效范围");
  return {
    id: nanoid(),
    nodeId,
    chapterId,
    versionId: version.id,
    contentHash: version.contentHash,
    evidence: { from, to, quote: version.content.slice(from, to) },
    interpretation,
    status: "confirmed",
  };
}
