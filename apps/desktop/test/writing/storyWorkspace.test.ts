import { testFirstReading } from '../helpers/writing';
/** TEST fixtures only. Scripted responses test orchestration, not real AI quality. */
import { beforeEach, expect, it } from "vitest";
import { useTestDb } from "../helpers/testDb";
import { testScene } from "../helpers/writing";
import { createNovel, purgeNovel } from "@/db/repos/novelsRepo";
import {
  createVersion,
  getChapter,
  getVersion,
  upsertChapterPlan,
  deleteVersion,
  saveSessionEdit,
} from "@/db/repos/chaptersRepo";
import { reorderChapters } from "@/db/repos/chapterStructureRepo";
import {
  editStoryScene,
  getStoryGraph,
  listStoryChanges,
  loadStoryWorkspace,
  makeStoryAnchor,
  saveStoryGraph,
  undoStoryChange,
  assertStoryTextEdit,
} from "@/db/repos/storyGraphRepo";
import {
  chapterDependencies,
  listWritingCards,
  saveWritingCard,
} from "@/db/repos/writingRepo";
import {
  createMandate,
  listMandates,
  runMandate,
  applyStoryProposal,
} from "@/novel/storyMandates";
import { assistantRequest, listTextProposals } from "@/novel/assistant";
import {
  createStoryBranch,
  saveStoryBranch,
  mergeStoryBranch,
  branchConflicts,
  listStoryBranches,
} from "@/novel/storyBranches";
import { exportStoryGraph, importStoryGraph } from "@/sync/storyGraphTransfer";
import { defaultRequirements } from "@/novel/types";
import { getDb } from "@/db/db";
import {
  anchorState,
  createMaterials,
  emptyStoryline,
  validateMaterialSources,
} from "@the-water/shared";
import { createProvider } from "@/db/repos/providersRepo";
import { setSecretStore } from "@/secrets/keychain";
import { setFetchImpl } from "@/llm/registry";
import { sseBody, sseResponse } from "../llm/helpers";
import {
  acceptStoryReading,
  listStoryReadings,
  readStoryProse,
} from "@/novel/storyIntelligence";
import {
  buildStorylineDoc,
  replaceStorylineRows,
  upsertBeat,
} from "@/db/repos/storylineRepo";
import { editStoryBeat } from "@/db/repos/storyGraphRepo";

beforeEach(() => useTestDb());
async function fixture(prose = "TEST original A. TEST original B.") {
  const novel = await createNovel({
    title: "TEST author workspace",
    premise: "TEST fictional story",
    requirements: defaultRequirements(),
    targetChars: 1000,
  });
  const chapter = await upsertChapterPlan(novel.id, {
    chapterNo: 1,
    title: "TEST chapter",
    targetChars: 1000,
  });
  const a = await testScene(novel.id, chapter.id),
    b = await testScene(novel.id, chapter.id);
  const version = prose
    ? await createVersion({
        chapterId: chapter.id,
        content: prose,
        source: "user_edit",
      })
    : null;
  return { novel, chapter, a, b, version };
}
async function testProvider() {
  setSecretStore({
    get: async () => "TEST",
    set: async () => undefined,
    delete: async () => undefined,
  });
  await createProvider({
    name: "TEST provider",
    kind: "openai_compatible",
    baseUrl: "https://test.invalid/v1",
    model: "TEST",
    contextWindow: 128000,
    maxOutputTokens: 8000,
    jsonMode: "json_object",
    temperature: 0.1,
    extraHeaders: {},
    secretRef: "TEST",
  });
  let count = 0;
  setFetchImpl(async () => {
    count++;
    return sseResponse([
      sseBody([
        {
          data: {
            choices: [
              {
                delta: { content: "TEST generated candidate" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 4 },
          },
        },
        { data: "[DONE]" },
      ]),
    ]);
  });
  return () => count;
}
it("TEST migration leaves old scene time unspecified and chapter reorder preserves graph IDs", async () => {
  const { novel, chapter, a } = await fixture();
  const later = await upsertChapterPlan(novel.id, {
    chapterNo: 2,
    title: "TEST later",
  });
  const { graph } = await getStoryGraph(novel.id);
  expect(graph.nodes).toEqual([]);
  graph.nodes.push({
    id: a,
    arcId: null,
    time: { label: "TEST world day", start: -1, end: null },
  });
  await saveStoryGraph(novel.id, 0, graph, "TEST world time");
  await reorderChapters(novel.id, [later.id, chapter.id]);
  const w = await loadStoryWorkspace(novel.id);
  expect(w.nodes.find((n) => n.id === a)?.chapterNo).toBe(2);
  expect(w.graph.nodes[0]!.time.start).toBe(-1);
});
it("TEST graph and scene changes are atomic, undoable and reject concurrent overwrites", async () => {
  const { novel, chapter, a } = await fixture();
  const w = await loadStoryWorkspace(novel.id),
    card = w.cards.find((c) => c.id === a)!;
  if (card.kind !== "scene") throw new Error("TEST fixture kind");
  await editStoryScene(
    novel.id,
    0,
    card,
    { ...card.data, outcome: "TEST altered outcome" },
    chapter.id,
    4,
  );
  await expect(
    editStoryScene(novel.id, 0, card, card.data, chapter.id, 1),
  ).rejects.toThrow("变化");
  const history = await listStoryChanges(novel.id);
  await undoStoryChange(novel.id, history[0]!.id);
  const actual = (await listWritingCards(novel.id)).find((c) => c.id === a)!;
  expect(actual.data).toEqual(card.data);
  expect(actual.order).toBe(card.order);
});
it("TEST cross-work references and impossible world-time cycles cannot be saved", async () => {
  const f = await fixture(),
    other = await fixture(),
    { graph } = await getStoryGraph(f.novel.id);
  graph.nodes.push({
    id: other.a,
    arcId: null,
    time: { label: "", start: null, end: null },
  });
  await expect(
    saveStoryGraph(f.novel.id, 0, graph, "TEST invalid"),
  ).rejects.toThrow("删除");
  graph.nodes = [];
  graph.relations = [
    {
      id: "TEST-1",
      from: f.a,
      to: f.b,
      kind: "before",
      reason: "TEST",
      status: "confirmed",
    },
    {
      id: "TEST-2",
      from: f.b,
      to: f.a,
      kind: "before",
      reason: "TEST",
      status: "confirmed",
    },
  ];
  await expect(
    saveStoryGraph(f.novel.id, 0, graph, "TEST cycle"),
  ).rejects.toThrow("循环");
});
it("TEST original evidence stays immutable, survives version pruning, and flags later prose changes", async () => {
  const { novel, chapter, a } = await fixture();
  const version = await saveSessionEdit({
    chapterId: chapter.id,
    content: "TEST session text",
    sessionId: "TEST-session",
  });
  const anchor = await makeStoryAnchor(a, chapter.id, 0, 4);
  const { graph } = await getStoryGraph(novel.id);
  graph.anchors.push(anchor);
  await saveStoryGraph(novel.id, 0, graph, "TEST anchor");
  const next = await saveSessionEdit({
    chapterId: chapter.id,
    content: "TEST revised session",
    sessionId: "TEST-session",
  });
  expect(next.id).not.toBe(version.id);
  expect((await getVersion(anchor.versionId))?.content).toBe(
    "TEST session text",
  );
  expect(anchorState(anchor, next)).toBe("changed");
  await expect(deleteVersion(anchor.versionId)).rejects.toThrow("依据");
});
it("TEST locks protect legacy card editors and scoped text while allowing an unrelated range", async () => {
  const { novel, chapter, a, version } = await fixture();
  const anchor = await makeStoryAnchor(a, chapter.id, 0, 16),
    { graph } = await getStoryGraph(novel.id);
  graph.anchors.push(anchor);
  graph.lockedNodeIds.push(a);
  await saveStoryGraph(novel.id, 0, graph, "TEST lock");
  const card = (await listWritingCards(novel.id)).find((c) => c.id === a)!;
  if (card.kind !== "scene") throw new Error("TEST fixture kind");
  await expect(
    saveWritingCard(
      novel.id,
      { kind: "scene", data: { ...card.data, outcome: "TEST forbidden" } },
      { id: a, expectedRevision: card.revision, confirmed: true },
    ),
  ).rejects.toThrow("Author-locked");
  await expect(
    assertStoryTextEdit(novel.id, chapter.id, version!.content, 0, 5),
  ).rejects.toThrow("锁定");
  await assertStoryTextEdit(novel.id, chapter.id, version!.content, 17, 20);
  await expect(
    createVersion({
      chapterId: chapter.id,
      content: "TEST replaced whole chapter",
      source: "generated",
    }),
  ).rejects.toThrow("锁定");
});
it("TEST local assignment requires a current anchor and does not silently authorize an entire chapter", async () => {
  const { novel, a, b } = await fixture();
  await expect(
    createMandate(novel.id, [a], { must: "", may: "", mustNot: "" }),
  ).rejects.toThrow("唯一且有效");
  const m = await createMandate(novel.id, [a, b], {
    must: "TEST must",
    may: "TEST may",
    mustNot: "TEST fixed ending",
  });
  expect(m.targets).toHaveLength(1);
  expect(m.targets[0]!.to).toBeGreaterThan(0);
});
it("TEST scoped generation saves candidates, resumes without duplicate calls, and acceptance preserves outside prose", async () => {
  const calls = await testProvider(),
    { novel, chapter, a, version } = await fixture();
  const { graph } = await getStoryGraph(novel.id);
  graph.anchors.push(await makeStoryAnchor(a, chapter.id, 0, 16));
  await saveStoryGraph(novel.id, 0, graph, "TEST link");
  const m = await createMandate(novel.id, [a], {
    must: "TEST choice",
    may: "",
    mustNot: "TEST keep second scene",
  });
  await runMandate(
    novel.id,
    m.id,
    new AbortController().signal,
    () => undefined,
  );
  expect(calls()).toBe(1);
  const proposal = (await listTextProposals(chapter.id))[0]!;
  expect((await getChapter(chapter.id))!.currentVersionId).toBe(version!.id);
  // TEST emulate process interruption between durable proposal and target checkpoint.
  await getDb().execute("UPDATE story_mandates SET json=? WHERE id=?", [
    JSON.stringify({ ...m, state: "running" }),
    m.id,
  ]);
  await runMandate(
    novel.id,
    m.id,
    new AbortController().signal,
    () => undefined,
  );
  expect(calls()).toBe(1);
  expect((await listMandates(novel.id))[0]!.state).toBe("completed");
  await applyStoryProposal(novel.id, chapter.id, proposal.id);
  const accepted = await getVersion(
    (await getChapter(chapter.id))!.currentVersionId!,
  );
  expect(accepted!.content).toBe(
    "TEST generated candidate" + version!.content.slice(16),
  );
  expect(accepted!.committedAt).toBeNull();
});
it("TEST aborted assignment persists recovery and cannot generate beyond granted range", async () => {
  const calls = await testProvider(),
    { novel, chapter, a, b, version } = await fixture();
  const m = await createMandate(novel.id, [a, b], {
    must: "",
    may: "",
    mustNot: "",
  });
  const ac = new AbortController();
  ac.abort();
  await expect(
    runMandate(novel.id, m.id, ac.signal, () => undefined),
  ).rejects.toThrow("中断");
  expect((await listMandates(novel.id))[0]!.state).toBe("paused");
  await expect(
    assistantRequest({
      novelId: novel.id,
      chapterId: chapter.id,
      versionId: version!.id,
      text: version!.content,
      from: 1,
      to: 5,
      operation: "rewrite",
      instruction: "TEST",
      sourceIds: [a, b],
      mandateId: m.id,
      signal: new AbortController().signal,
      onDelta: () => undefined,
    }),
  ).rejects.toThrow("授权");
  expect(calls()).toBe(0);
});
it("TEST branch edits and facts remain isolated, merge rejects concurrent plans, and untouched prose is retained", async () => {
  const { novel, chapter, a, version } = await fixture();
  const { graph } = await getStoryGraph(novel.id);
  graph.anchors.push(await makeStoryAnchor(a, chapter.id, 0, 16));
  await saveStoryGraph(novel.id, 0, graph, "TEST link");
  const branch = await createStoryBranch(novel.id, a, "TEST alternative");
  const edited = await saveStoryBranch(novel.id, branch, {
    name: branch.name,
    graph: branch.graph,
    plan: { ...branch.plan, outcome: "TEST branch consequence" },
    sample: "TEST alternative scene",
  });
  expect((await getChapter(chapter.id))!.currentVersionId).toBe(version!.id);
  expect(await branchConflicts(novel.id, edited)).toEqual([]);
  await mergeStoryBranch(novel.id, edited);
  expect(
    (await getVersion((await getChapter(chapter.id))!.currentVersionId!))!
      .content,
  ).toBe(edited.sample + version!.content.slice(16));
  await undoStoryChange(novel.id, (await listStoryChanges(novel.id))[0]!.id);
  expect(
    (await getVersion((await getChapter(chapter.id))!.currentVersionId!))!
      .content,
  ).toBe(version!.content);
  expect(
    (await listWritingCards(novel.id)).find((c) => c.id === a)!.data,
  ).toEqual(branch.basePlan);
  expect((await listStoryBranches(novel.id))[0]!.state).toBe("reverted");
  const other = await createStoryBranch(novel.id, a, "TEST conflict");
  const card = (await listWritingCards(novel.id)).find((c) => c.id === a)!;
  if (card.kind !== "scene") throw new Error("TEST fixture kind");
  await saveWritingCard(
    novel.id,
    { kind: "scene", data: { ...card.data, goal: "TEST concurrent edit" } },
    { id: a, expectedRevision: card.revision, confirmed: true },
  );
  expect(await branchConflicts(novel.id, other)).toContain("plan");
  await expect(mergeStoryBranch(novel.id, other)).rejects.toThrow("冲突");
});
it("TEST sharing remaps stable graph, scene, chapter, version and evidence IDs without leaking inbox", async () => {
  const { novel, chapter, a } = await fixture("");
  const text = "TEST published prose";
  await createVersion({
    chapterId: chapter.id,
    content: text,
    source: "imported",
  });
  const { graph } = await getStoryGraph(novel.id);
  graph.anchors.push(await makeStoryAnchor(a, chapter.id, 0, 4));
  graph.nodes.push({
    id: a,
    arcId: null,
    time: { label: "TEST time", start: 2, end: null },
  });
  graph.inbox.push({
    id: "TEST-private",
    kind: "idea",
    text: "TEST private idea",
    source: "",
    nodeIds: [],
    resolved: false,
  });
  await saveStoryGraph(novel.id, 0, graph, "TEST share");
  const exported = await exportStoryGraph(novel.id, new Map([[1, text]]));
  const oldCard = (await listWritingCards(novel.id)).find((c) => c.id === a)!;
  const material = await createMaterials([
    ...exported,
    { type: "plan", id: a, chapterNo: 1, order: 0, card: oldCard },
  ]);
  await validateMaterialSources(material, [{ index: 0, content: text }], {
    ...emptyStoryline(),
    chapters: [
      {
        chapterNo: 1,
        title: "TEST",
        goal: "",
        targetChars: 1000,
        beatIds: [],
        povCharacterId: null,
        endHook: "",
      },
    ],
  });
  const dest = await fixture("");
  await createVersion({
    chapterId: dest.chapter.id,
    content: text,
    source: "imported",
  });
  await importStoryGraph(
    dest.novel.id,
    exported.flatMap((c) => (c.type === "story_graph" ? [c] : [])),
    new Map([[a, dest.a]]),
    new Map([[1, dest.chapter.id]]),
  );
  const local = await getStoryGraph(dest.novel.id);
  expect(local.graph.nodes[0]!.id).toBe(dest.a);
  expect(local.graph.anchors[0]!.chapterId).toBe(dest.chapter.id);
  expect(local.graph.inbox).toEqual([]);
});
it("TEST deleting a whole work also cleans up its graph without orphaning records", async () => {
  const { novel, a } = await fixture(),
    { graph } = await getStoryGraph(novel.id);
  graph.lockedNodeIds.push(a);
  await saveStoryGraph(novel.id, 0, graph, "TEST");
  await purgeNovel(novel.id);
  expect(
    await getDb().select("SELECT * FROM story_graphs WHERE novel_id=?", [
      novel.id,
    ]),
  ).toEqual([]);
});
it("TEST changing accepted story-time constraints invalidates candidate dependency hashes", async () => {
  const { novel, a } = await fixture(),
    before = await chapterDependencies(novel.id, 1),
    { graph } = await getStoryGraph(novel.id);
  graph.nodes.push({
    id: a,
    arcId: null,
    time: { label: "TEST earlier", start: -2, end: -1 },
  });
  await saveStoryGraph(novel.id, 0, graph, "TEST time");
  expect((await chapterDependencies(novel.id, 1)).hash).not.toBe(before.hash);
});
it("TEST evidence-backed extraction stages suggestions; adoption updates the same scene only after review", async () => {
  await testProvider();
  const { novel, chapter, a, version } = await fixture();
  const card = (await listWritingCards(novel.id)).find((c) => c.id === a)!;
  if (card.kind !== "scene") throw new Error("TEST fixture");
  const reading = {
    scenes: [
      {
        existingSceneId: a,
        plan: { ...card.data, outcome: "TEST extracted outcome" },
        evidence: { from: 999, to: 1003, quote: "TEST original A." },
        interpretation: "TEST scripted editorial inference",
      },
      {
        existingSceneId: null,
        plan: { ...card.data, title: "TEST newly extracted scene" },
        evidence: { from: 17, to: 33, quote: "TEST original B." },
        interpretation: "TEST new scene inference",
      },
    ],
    issues: [
      {
        kind: "deviation",
        purpose: "TEST explain deviation",
        suggestion: "TEST author choice",
        evidence: { from: 0, to: 16, quote: "TEST original A." },
      },
    ],
  };
  setFetchImpl(async () =>
    sseResponse([
      sseBody([
        {
          data: {
            choices: [
              {
                delta: { content: JSON.stringify({...reading,...testFirstReading()}) },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          },
        },
        { data: "[DONE]" },
      ]),
    ]),
  );
  const id = await readStoryProse(
    novel.id,
    chapter.id,
    new AbortController().signal,
  );
  expect(
    (await listWritingCards(novel.id)).find((c) => c.id === a)!.data,
  ).toEqual(card.data);
  expect(
    (await listStoryReadings(novel.id))[0]!.reading.scenes[0]!.evidence.from,
  ).toBe(0);
  await acceptStoryReading(novel.id, id);
  const w = await loadStoryWorkspace(novel.id);
  expect(w.cards).toHaveLength(3);
  expect(w.graph.anchors[0]!.versionId).toBe(version!.id);
  expect(w.graph.anchors[0]!.status).toBe("confirmed");
  expect(await getDb().select("SELECT * FROM canon_events")).toEqual([]);
  await undoStoryChange(novel.id, (await listStoryChanges(novel.id))[0]!.id);
  const restored = await loadStoryWorkspace(novel.id);
  expect(restored.cards).toHaveLength(2);
  expect(restored.cards.find((c) => c.id === a)!.data).toEqual(card.data);
  expect(restored.graph.anchors).toEqual([]);
  expect((await getChapter(chapter.id))!.currentVersionId).toBe(version!.id);
});
it("TEST missing model evidence fails without creating plans, anchors or a successful reading", async () => {
  await testProvider();
  const { novel, chapter, a } = await fixture();
  const card = (await listWritingCards(novel.id)).find((c) => c.id === a)!;
  const output = {
    scenes: [
      {
        existingSceneId: a,
        plan: card.data,
        evidence: {
          from: 0,
          to: 10,
          quote: "TEST invented quotation not in source",
        },
        interpretation: "TEST invalid response",
      },
    ],
    issues: [],
  };
  setFetchImpl(async () =>
    sseResponse([
      sseBody([
        {
          data: {
            choices: [
              {
                delta: { content: JSON.stringify({...output,...testFirstReading()}) },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          },
        },
        { data: "[DONE]" },
      ]),
    ]),
  );
  await expect(
    readStoryProse(novel.id, chapter.id, new AbortController().signal),
  ).rejects.toThrow("scenes.0.evidence: quote 必须是正文中唯一的连续逐字原文");
  expect(await listStoryReadings(novel.id)).toEqual([]);
  expect((await getStoryGraph(novel.id)).graph.anchors).toEqual([]);
});
it("TEST stable event edits can be undone and replacing an unchanged outline retains linked events", async () => {
  const { novel, chapter } = await fixture();
  const beat = await upsertBeat(novel.id, {
    title: "TEST event",
    summary: "TEST original",
    chapterNo: chapter.chapterNo,
  });
  const { graph } = await getStoryGraph(novel.id);
  graph.nodes.push({
    id: beat.id,
    arcId: null,
    time: { label: "TEST", start: null, end: null },
  });
  await saveStoryGraph(novel.id, 0, graph, "TEST event");
  await editStoryBeat(novel.id, 1, beat, { ...beat, summary: "TEST revised" });
  await undoStoryChange(novel.id, (await listStoryChanges(novel.id))[0]!.id);
  const doc = await buildStorylineDoc(novel.id, novel.premise);
  expect(doc.beats[0]!.summary).toBe("TEST original");
  await replaceStorylineRows(novel.id, doc);
  expect(
    (await loadStoryWorkspace(novel.id)).nodes.some((n) => n.id === beat.id),
  ).toBe(true);
});
