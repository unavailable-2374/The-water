import { z } from "zod";
import { EvidenceSchema, verifyEvidence } from "./writing";

const id = z.string().min(1).max(100);
const text = z.string().max(12000);
export const StoryAnchorSchema = z.object({
  id,
  nodeId: id,
  chapterId: id,
  versionId: id,
  contentHash: z.string().length(64),
  evidence: EvidenceSchema,
  // A quotation proves what was written, not the model's interpretation of it.
  interpretation: text,
  status: z.enum(["proposed", "confirmed"]),
});
export type StoryAnchor = z.infer<typeof StoryAnchorSchema>;
export const StoryGraphSchema = z
  .object({
    version: z.literal(1),
    nodes: z
      .array(
        z.object({
          id,
          arcId: id.nullable(),
          time: z
            .object({
              label: text,
              start: z.number().finite().nullable(),
              end: z.number().finite().nullable(),
            })
            .refine(
              (v) => v.start === null || v.end === null || v.start <= v.end,
              "事件结束时间早于开始时间",
            ),
        }),
      )
      .max(10000),
    relations: z
      .array(
        z.object({
          id,
          from: id,
          to: id,
          kind: z.enum([
            "causes",
            "requires",
            "before",
            "parallel",
            "setup",
            "payoff",
          ]),
          status: z.enum(["proposed", "confirmed"]),
          reason: text.min(1),
        }),
      )
      .max(20000),
    anchors: z.array(StoryAnchorSchema).max(20000),
    secrets: z
      .array(
        z.object({
          id,
          fact: text.min(1),
          readerAt: id.nullable(),
          knowledge: z
            .array(
              z.object({
                characterId: id,
                at: id,
                state: z.enum(["knows", "believes"]),
                belief: text,
              }),
            )
            .max(1000),
        }),
      )
      .max(1000),
    growth: z
      .array(
        z.object({
          id,
          characterId: id,
          at: id,
          relatedCharacterId: id.nullable(),
          kind: z.enum([
            "goal",
            "belief",
            "relationship",
            "situation",
            "choice",
          ]),
          before: text,
          after: text,
          anchorId: id.nullable(),
        }),
      )
      .max(10000),
    lockedNodeIds: z.array(id).max(10000),
    lockedAnchors: z.array(StoryAnchorSchema).max(10000),
    preferences: z.object({
      narration: text,
      dialogue: text,
      forbidden: z.array(z.string().min(1).max(200)).max(100),
      sampleAnchorIds: z.array(id).max(100),
      confirmed: z.boolean(),
    }),
    inbox: z
      .array(
        z.object({
          id,
          kind: z.enum(["research", "fiction", "idea"]),
          text: text.min(1),
          source: text,
          nodeIds: z.array(id).max(200),
          resolved: z.boolean(),
        }),
      )
      .max(10000),
  })
  .strict()
  .superRefine((v, ctx) => {
    for (const key of [
      "nodes",
      "relations",
      "anchors",
      "secrets",
      "growth",
      "lockedAnchors",
      "inbox",
    ] as const) {
      if (new Set(v[key].map((x) => x.id)).size !== v[key].length)
        ctx.addIssue({ code: "custom", path: [key], message: "重复的稳定 ID" });
    }
    for (const r of v.relations)
      if (r.from === r.to)
        ctx.addIssue({
          code: "custom",
          path: ["relations"],
          message: "不能关联事件自身",
        });
  });
export type StoryGraph = z.infer<typeof StoryGraphSchema>;
export function emptyStoryGraph(): StoryGraph {
  return {
    version: 1,
    nodes: [],
    relations: [],
    anchors: [],
    secrets: [],
    growth: [],
    lockedNodeIds: [],
    lockedAnchors: [],
    preferences: {
      narration: "",
      dialogue: "",
      forbidden: [],
      sampleAnchorIds: [],
      confirmed: false,
    },
    inbox: [],
  };
}

export interface StoryNode {
  id: string;
  title: string;
  kind: "scene" | "beat";
  chapterId: string | null;
  chapterNo: number | null;
  order: number;
  characterIds: string[];
  volumeId: string | null;
  arcId: string | null;
}
/** The desktop and bundle validator share the same topology contract. */
export function validateStoryGraphTopology(
  graph: StoryGraph,
  source: {
    nodes: StoryNode[];
    characters: string[];
    arcs: string[];
    available: string[];
  },
) {
  const available = new Set(source.available);
  const missing = graphReferences(graph).filter((id) => !available.has(id));
  if (missing.length) throw new Error(`关联对象已删除：${missing.join("、")}`);
  const nodeIds = new Set(source.nodes.map((n) => n.id));
  const characterIds = new Set(source.characters),
    arcIds = new Set(source.arcs);
  const node = (id: string) => {
    if (!nodeIds.has(id)) throw new Error("事件关联必须指向场景或情节点");
  };
  graph.nodes.forEach((n) => {
    node(n.id);
    if (n.arcId && !arcIds.has(n.arcId)) throw new Error("故事弧不存在");
  });
  graph.relations.forEach((r) => {
    node(r.from);
    node(r.to);
  });
  [...graph.anchors, ...graph.lockedAnchors].forEach((a) => node(a.nodeId));
  graph.secrets.forEach((s) => {
    if (s.readerAt) node(s.readerAt);
    s.knowledge.forEach((k) => {
      node(k.at);
      if (!characterIds.has(k.characterId)) throw new Error("知情人物不存在");
    });
  });
  graph.growth.forEach((g) => {
    node(g.at);
    if (
      !characterIds.has(g.characterId) ||
      (g.relatedCharacterId && !characterIds.has(g.relatedCharacterId))
    )
      throw new Error("成长记录人物不存在");
  });
  if (worldTimeline(source.nodes, graph).cycles.length)
    throw new Error("事件时间与先后约束存在循环，请先消除冲突");
  const anchors = new Set(graph.anchors.map((a) => a.id));
  if (
    graph.preferences.sampleAnchorIds.some((id) => !anchors.has(id)) ||
    graph.growth.some((g) => g.anchorId && !anchors.has(g.anchorId))
  )
    throw new Error("引用的原文证据不存在");
}
export function narrativeOrder(nodes: StoryNode[]): StoryNode[] {
  return [...nodes].sort(
    (a, b) =>
      (a.chapterNo ?? Infinity) - (b.chapterNo ?? Infinity) ||
      a.order - b.order ||
      a.id.localeCompare(b.id),
  );
}
/** Partial order: incomparable events stay in one layer, never assigned invented dates. */
export function worldTimeline(
  nodes: StoryNode[],
  graph: StoryGraph,
): { layers: StoryNode[][]; cycles: string[] } {
  const remaining = new Map(nodes.map((n) => [n.id, n]));
  type Key = string | number;
  const incoming = new Map<Key, number>(nodes.map((n) => [n.id, 0]));
  const outgoing = new Map<Key, Set<Key>>();
  const edge = (from: Key, to: Key) => {
    const values = outgoing.get(from) ?? new Set<Key>();
    if (!values.has(to)) {
      values.add(to);
      incoming.set(to, (incoming.get(to) ?? 0) + 1);
    }
    outgoing.set(from, values);
  };
  for (const r of graph.relations)
    if (
      r.status === "confirmed" &&
      r.kind === "before" &&
      remaining.has(r.to) &&
      remaining.has(r.from)
    )
      edge(r.from, r.to);
  // Virtual barriers give O(nodes + edges) ordering after sorting. No all-pairs time edges.
  const groups = new Map<number, string[]>();
  for (const n of graph.nodes)
    if (n.time.start !== null && remaining.has(n.id)) {
      const group = groups.get(n.time.start) ?? [];
      group.push(n.id);
      groups.set(n.time.start, group);
    }
  const times = [...groups.keys()].sort((a, b) => a - b);
  for (let i = 0; i < times.length; i++) {
    if (!incoming.has(i)) incoming.set(i, 0);
    if (!incoming.has(i + 1)) incoming.set(i + 1, 0);
    for (const id of groups.get(times[i]!)!) {
      edge(i, id);
      edge(id, i + 1);
    }
  }
  let ready: Key[] = [...incoming.keys()].filter((k) => incoming.get(k) === 0);
  const release = (key: Key, queue: Key[]) => {
    incoming.delete(key);
    for (const to of outgoing.get(key) ?? []) {
      const n = incoming.get(to)! - 1;
      incoming.set(to, n);
      if (!n) queue.push(to);
    }
  };
  const layers: StoryNode[][] = [];
  while (ready.length) {
    const layer: StoryNode[] = [];
    for (let i = 0; i < ready.length; i++) {
      const key = ready[i]!;
      if (typeof key === "number") release(key, ready);
      else layer.push(remaining.get(key)!);
    }
    const next: Key[] = [];
    for (const n of layer) {
      remaining.delete(n.id);
      release(n.id, next);
    }
    if (layer.length) layers.push(layer);
    ready = next;
  }
  return { layers, cycles: [...remaining.keys()] };
}
export interface StoryImpact {
  nodeId: string;
  certainty: "confirmed" | "proposed";
  path: StoryGraph["relations"];
}
/** Propagate uncertainty; an inferred edge must never become a certain downstream dependency. */
export function storyImpact(graph: StoryGraph, roots: string[]): StoryImpact[] {
  const result = new Map<string, StoryImpact>();
  const queue: StoryImpact[] = roots.map((nodeId) => ({
    nodeId,
    certainty: "confirmed",
    path: [],
  }));
  const outgoing = new Map<string, StoryGraph["relations"]>();
  for (const r of graph.relations) {
    if (r.kind === "parallel" || r.kind === "before") continue;
    const edges = outgoing.get(r.from) ?? [];
    edges.push(r);
    outgoing.set(r.from, edges);
  }
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    const old = result.get(current.nodeId);
    if (
      old &&
      (old.certainty === "confirmed" || current.certainty === "proposed")
    )
      continue;
    result.set(current.nodeId, current);
    for (const edge of outgoing.get(current.nodeId) ?? [])
      queue.push({
        nodeId: edge.to,
        certainty:
          current.certainty === "confirmed" && edge.status === "confirmed"
            ? "confirmed"
            : "proposed",
        path: [...current.path, edge],
      });
  }
  return [...result.values()];
}
export function anchorState(
  anchor: StoryAnchor,
  version: { id: string; contentHash: string; content: string } | null,
): "current" | "changed" | "missing" {
  if (!version) return "missing";
  return anchor.versionId === version.id &&
    anchor.contentHash === version.contentHash &&
    verifyEvidence(version.content, anchor.evidence)
    ? "current"
    : "changed";
}
export function graphReferences(graph: StoryGraph): string[] {
  return [
    ...new Set([
      ...graph.nodes.flatMap((n) => [n.id, ...(n.arcId ? [n.arcId] : [])]),
      ...graph.relations.flatMap((r) => [r.from, r.to]),
      ...graph.anchors.map((a) => a.nodeId),
      ...graph.lockedNodeIds,
      ...graph.lockedAnchors.map((a) => a.nodeId),
      ...graph.secrets.flatMap((s) => [
        ...(s.readerAt ? [s.readerAt] : []),
        ...s.knowledge.flatMap((k) => [k.at, k.characterId]),
      ]),
      ...graph.growth.flatMap((g) => [
        g.at,
        g.characterId,
        ...(g.relatedCharacterId ? [g.relatedCharacterId] : []),
      ]),
      ...graph.inbox.flatMap((i) => i.nodeIds),
    ]),
  ];
}
export function remapStoryGraph(
  graph: StoryGraph,
  ref: (id: string) => string,
): StoryGraph {
  const anchor = (a: StoryAnchor): StoryAnchor => ({
    ...a,
    id: ref(a.id),
    nodeId: ref(a.nodeId),
    chapterId: ref(a.chapterId),
    versionId: ref(a.versionId),
  });
  return StoryGraphSchema.parse({
    ...graph,
    nodes: graph.nodes.map((n) => ({
      ...n,
      id: ref(n.id),
      arcId: n.arcId ? ref(n.arcId) : null,
    })),
    relations: graph.relations.map((r) => ({
      ...r,
      id: ref(r.id),
      from: ref(r.from),
      to: ref(r.to),
    })),
    anchors: graph.anchors.map(anchor),
    lockedAnchors: graph.lockedAnchors.map(anchor),
    lockedNodeIds: graph.lockedNodeIds.map(ref),
    secrets: graph.secrets.map((s) => ({
      ...s,
      id: ref(s.id),
      readerAt: s.readerAt ? ref(s.readerAt) : null,
      knowledge: s.knowledge.map((k) => ({
        ...k,
        characterId: ref(k.characterId),
        at: ref(k.at),
      })),
    })),
    growth: graph.growth.map((g) => ({
      ...g,
      id: ref(g.id),
      characterId: ref(g.characterId),
      at: ref(g.at),
      relatedCharacterId: g.relatedCharacterId
        ? ref(g.relatedCharacterId)
        : null,
      anchorId: g.anchorId ? ref(g.anchorId) : null,
    })),
    preferences: {
      ...graph.preferences,
      sampleAnchorIds: graph.preferences.sampleAnchorIds.map(ref),
    },
    inbox: graph.inbox.map((i) => ({
      ...i,
      id: ref(i.id),
      nodeIds: i.nodeIds.map(ref),
    })),
  });
}

export const WritingMandateSchema = z.object({
  id,
  nodeIds: z.array(id).min(1).max(200),
  must: text,
  may: text,
  mustNot: text,
  graphRevision: z.number().int().nonnegative(),
  state: z.enum(["ready", "running", "paused", "completed", "cancelled"]),
  // Each range is frozen against a real version. No whole-chapter fallback for missing scene anchors.
  targets: z
    .array(
      z.object({
        nodeIds: z.array(id),
        chapterId: id,
        versionId: id.nullable(),
        contentHash: z.string().length(64),
        dependencyHash: z.string().length(64),
        from: z.number().int().nonnegative(),
        to: z.number().int().nonnegative(),
        proposalId: id.nullable(),
        state: z.enum(["pending", "done"]),
      }),
    )
    .max(200),
  error: z.string().nullable(),
});
export type WritingMandate = z.infer<typeof WritingMandateSchema>;
