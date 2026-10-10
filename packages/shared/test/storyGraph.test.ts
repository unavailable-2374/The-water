/** TEST / synthetic story structures; these assertions are not literary-quality evidence. */
import { describe, expect, it } from "vitest";
import {
  anchorState,
  emptyStoryGraph,
  narrativeOrder,
  storyImpact,
  worldTimeline,
  type StoryNode,
} from "../src/storyGraph";
import {
  combineGraphMaterials,
  createMaterials,
  graphMaterialCards,
} from "../src/creationMaterials";

const node = (id: string, chapterNo: number): StoryNode => ({
  id,
  chapterNo,
  chapterId: `TEST-ch${chapterNo}`,
  title: `TEST ${id}`,
  kind: "scene",
  order: 0,
  characterIds: [],
  volumeId: null,
  arcId: null,
});
describe("TEST dual timelines and uncertainty", () => {
  it("keeps flashback world time independent from reordered narration", () => {
    const g = emptyStoryGraph();
    g.nodes = [
      {
        id: "TEST-past",
        arcId: null,
        time: { label: "TEST earlier", start: 1, end: null },
      },
      {
        id: "TEST-present",
        arcId: null,
        time: { label: "TEST later", start: 10, end: 12 },
      },
    ];
    const nodes = [node("TEST-present", 1), node("TEST-past", 2)];
    expect(narrativeOrder(nodes).map((n) => n.id)).toEqual([
      "TEST-present",
      "TEST-past",
    ]);
    expect(
      worldTimeline(nodes, g).layers.map((l) => l.map((n) => n.id)),
    ).toEqual([["TEST-past"], ["TEST-present"]]);
    expect(
      worldTimeline(
        nodes.map((n) => ({ ...n, chapterNo: 3 - n.chapterNo! })),
        g,
      ).layers.map((l) => l.map((n) => n.id)),
    ).toEqual([["TEST-past"], ["TEST-present"]]);
  });
  it("keeps unknown parallel storylines unordered and detects contradictory time constraints", () => {
    const g = emptyStoryGraph(),
      nodes = [node("TEST-a", 1), node("TEST-b", 2), node("TEST-c", 3)];
    expect(worldTimeline(nodes, g).layers).toHaveLength(1);
    g.relations = [
      {
        id: "TEST-ab",
        from: "TEST-a",
        to: "TEST-b",
        kind: "before",
        status: "confirmed",
        reason: "TEST prerequisite",
      },
      {
        id: "TEST-ba",
        from: "TEST-b",
        to: "TEST-a",
        kind: "before",
        status: "confirmed",
        reason: "TEST contradiction",
      },
    ];
    expect(worldTimeline(nodes, g).cycles.sort()).toEqual(["TEST-a", "TEST-b"]);
    g.relations[1]!.status = "proposed";
    expect(worldTimeline(nodes, g).cycles).toEqual([]);
  });
  it("does not promote AI inference through a confirmed downstream edge; handles causal cycles", () => {
    const g = emptyStoryGraph();
    g.relations = [
      {
        id: "TEST-1",
        from: "a",
        to: "b",
        kind: "causes",
        status: "proposed",
        reason: "TEST inference",
      },
      {
        id: "TEST-2",
        from: "b",
        to: "c",
        kind: "requires",
        status: "confirmed",
        reason: "TEST accepted dependency",
      },
      {
        id: "TEST-3",
        from: "c",
        to: "a",
        kind: "causes",
        status: "confirmed",
        reason: "TEST loop",
      },
    ];
    expect(storyImpact(g, ["a"]).map((i) => [i.nodeId, i.certainty])).toEqual([
      ["a", "confirmed"],
      ["b", "proposed"],
      ["c", "proposed"],
    ]);
  });
  it("supports 5,000 timed scenes without quadratic all-pairs edges", () => {
    const nodes = Array.from({ length: 5000 }, (_, i) => node(`TEST-${i}`, 1)),
      g = emptyStoryGraph();
    g.nodes = nodes.map((n, i) => ({
      id: n.id,
      arcId: null,
      time: { label: "", start: i, end: null },
    }));
    expect(worldTimeline(nodes, g).layers).toHaveLength(5000);
  });
  it("flags source edits and missing versions, even if a quotation still exists", () => {
    const a = {
      id: "TEST",
      nodeId: "TEST",
      chapterId: "TEST",
      versionId: "TEST-v1",
      contentHash: "a".repeat(64),
      evidence: { from: 0, to: 4, quote: "TEST" },
      interpretation: "",
      status: "confirmed" as const,
    };
    expect(anchorState(a, null)).toBe("missing");
    expect(
      anchorState(a, {
        id: "TEST-v2",
        contentHash: a.contentHash,
        content: "TEST",
      }),
    ).toBe("changed");
    expect(
      anchorState(a, {
        id: a.versionId,
        contentHash: a.contentHash,
        content: "TEST",
      }),
    ).toBe("current");
  });
  it("round-trips large graph material blocks with independent character and reader knowledge", async () => {
    const g = emptyStoryGraph();
    g.secrets = [
      {
        id: "TEST-secret",
        fact: "TEST fact",
        readerAt: "TEST-reader",
        knowledge: [
          {
            characterId: "TEST-character",
            at: "TEST-earlier",
            state: "believes",
            belief: "TEST mistaken belief",
          },
        ],
      },
    ];
    g.nodes = Array.from({ length: 5000 }, (_, i) => ({
      id: `TEST-${i}`,
      arcId: null,
      time: { label: "TEST ".repeat(20), start: null, end: null },
    }));
    const cards = graphMaterialCards(g, []);
    expect(cards.length).toBeGreaterThan(1);
    const materials = await createMaterials(cards);
    expect(
      combineGraphMaterials(
        materials.blocks.flatMap((b) =>
          b.card.type === "story_graph" ? [b.card] : [],
        ),
      ),
    ).toEqual(g);
  });
});
