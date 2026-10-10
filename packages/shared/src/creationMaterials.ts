import { z } from 'zod';
import { CanonEventSchema, EvidenceSchema, WritingCardDataSchema } from './writing';
import { canonicalJson, sha256Hex, utf8ByteLength } from './hash';
import { verifyEvidence } from './writing';
import type { StorylineDoc } from './storyline';
import { StoryGraphSchema, emptyStoryGraph, validateStoryGraphTopology, type StoryGraph, type StoryNode } from './storyGraph';

export const MATERIAL_BLOCK_BYTES = 256 * 1024;
export const MATERIAL_TOTAL_BYTES = 16 * 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const MaterialCardSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('story_graph'), id: z.string(), graph: StoryGraphSchema,
    chapters: z.array(z.object({ id: z.string(), chapterNo: z.number().int().min(1).max(500) })).max(500),
  }).strict(),
  z
    .object({
      type: z.literal('plan'),
      id: z.string(),
      chapterNo: z.number().int().min(1).max(500).nullable(),
      order: z.number().int(),
      card: WritingCardDataSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('canon'),
      order: z.number().int().min(0),
      id: z.string(),
      chapterNo: z.number().int().min(1).max(500),
      sourceVersionId: z.string(),
      contentHash: hash,
      event: CanonEventSchema,
      origin: z.object({ contentHash: hash, evidence: EvidenceSchema }).optional(),
    })
    .strict(),
]);
export type MaterialCard = z.infer<typeof MaterialCardSchema>;
/** One card per independently hashed block. No discussion, draft, review or job fields. */
export const CreationMaterialsSchema = z
  .object({
    version: z.literal(1),
    manifest: z
      .array(
        z.object({ id: z.string(), hash, bytes: z.number().int().min(1).max(MATERIAL_BLOCK_BYTES) }).strict(),
      )
      .max(65536),
    blocks: z.array(z.object({ hash, card: MaterialCardSchema }).strict()).max(65536),
  })
  .strict();
export type CreationMaterials = z.infer<typeof CreationMaterialsSchema>;
export async function validateCreationMaterials(input: unknown): Promise<CreationMaterials> {
  const materials = CreationMaterialsSchema.parse(input);
  if (utf8ByteLength(canonicalJson(materials)) > MATERIAL_TOTAL_BYTES)
    throw new Error('Creation materials exceed 16 MiB');
  const blocks = new Map(materials.blocks.map((b) => [b.hash, b.card]));
  if (
    blocks.size !== materials.blocks.length ||
    new Set(materials.manifest.map((m) => m.id)).size !== materials.manifest.length ||
    materials.manifest.length !== blocks.size
  )
    throw new Error('Duplicate or unlisted material block');
  for (const entry of materials.manifest) {
    const card = blocks.get(entry.hash);
    if (!card) throw new Error(`Missing material block: ${entry.hash}`);
    const text = canonicalJson(card),
      bytes = utf8ByteLength(text);
    if (
      card.id !== entry.id ||
      bytes !== entry.bytes ||
      bytes > MATERIAL_BLOCK_BYTES ||
      (await sha256Hex(text)) !== entry.hash
    )
      throw new Error(`Material block hash or size mismatch: ${entry.id}`);
  }
  return materials;
}
export async function createMaterials(cards: MaterialCard[]): Promise<CreationMaterials> {
  const manifest: CreationMaterials['manifest'] = [],
    blocks: CreationMaterials['blocks'] = [];
  for (const card of cards) {
    const text = canonicalJson(MaterialCardSchema.parse(card)),
      hash = await sha256Hex(text);
    manifest.push({ id: card.id, hash, bytes: utf8ByteLength(text) });
    blocks.push({ hash, card });
  }
  return validateCreationMaterials({ version: 1, manifest, blocks });
}

/** Validate evidence and graph references before a version becomes downloadable. */
export async function validateMaterialSources(
  materials: CreationMaterials,
  chapters: Array<{ index: number; content: string }>,
  storyline: StorylineDoc,
): Promise<void> {
  const cards = new Map(materials.blocks.map((b) => [b.card.id, b.card]));
  const characters = new Set(storyline.characters.map((c) => c.id)),
    arcs = new Set(storyline.arcs.map((a) => a.id));
  const chapterNos = new Set(storyline.chapters.map((c) => c.chapterNo));
  const reference = (id: string, kind?: string) => {
    const c = cards.get(id);
    if (!c || (kind && !(c.type === 'plan' && c.card.kind === kind)))
      throw new Error(`Missing material reference: ${id}`);
  };
  const character = (id: string) => {
    if (!characters.has(id)) throw new Error(`Unknown material character: ${id}`);
  };
  for (const card of cards.values()) {
    if (card.type === 'canon') {
      if (card.id !== card.event.id) throw new Error('Material/event IDs differ');
      const source = chapters.find((c) => c.index === card.chapterNo - 1);
      if (
        !source ||
        (await sha256Hex(source.content)) !== card.contentHash ||
        !verifyEvidence(source.content, card.event.evidence)
      )
        throw new Error(`Invalid material evidence: ${card.id}`);
      if (card.event.entityId) character(card.event.entityId);
      card.event.knownBy.forEach(character);
      if (card.event.threadId) reference(card.event.threadId, 'thread');
      for (const id of card.event.dependencyIds) {
        reference(id);
        const dep = cards.get(id)!;
        if (
          dep.type !== 'canon' ||
          dep.chapterNo > card.chapterNo ||
          (dep.chapterNo === card.chapterNo && dep.order >= card.order)
        )
          throw new Error(`Invalid material dependency: ${id}`);
      }
    } else if (card.type === 'plan') {
      if (card.chapterNo !== null && !chapterNos.has(card.chapterNo))
        throw new Error(`Unknown material chapter: ${card.chapterNo}`);
      const plan = card.card;
      if (plan.kind === 'scene') {
        if (plan.data.volumeId) reference(plan.data.volumeId, 'volume');
        if (plan.data.povCharacterId) character(plan.data.povCharacterId);
        plan.data.characterIds.forEach(character);
        plan.data.threadIds.forEach((id) => reference(id, 'thread'));
        plan.data.dependencyIds.forEach((id) => reference(id));
      }
      if (plan.kind === 'character') character(plan.data.characterId);
      if (plan.kind === 'thread') plan.data.characterIds.forEach(character);
      if (plan.kind === 'volume' && plan.data.arcIds.some((id) => !arcs.has(id)))
        throw new Error('Unknown material arc');
    }
  }
  const graphCards = [...cards.values()].filter(c => c.type === 'story_graph');
  if (graphCards.length) {
    const graph = combineGraphMaterials(graphCards);
    const nodes: StoryNode[] = [...cards.values()].flatMap(c => c.type === 'plan' && c.card.kind === 'scene' ? [{ id: c.id, title: c.card.data.title, kind: 'scene', chapterNo: c.chapterNo, chapterId: null, order: c.order, characterIds: c.card.data.characterIds, volumeId: c.card.data.volumeId, arcId: null }] : []);
    nodes.push(...storyline.beats.map(b => ({ id: b.id, title: b.title, kind: 'beat' as const, chapterNo: b.chapterNo, chapterId: null, order: b.order, characterIds: b.characterIds, volumeId: null, arcId: b.arcId })));
    validateStoryGraphTopology(graph, { nodes, characters: [...characters], arcs: [...arcs], available: [...cards.keys(), ...storyline.characters.map(c => c.id), ...storyline.settings.map(c => c.id), ...storyline.arcs.map(c => c.id), ...storyline.beats.map(c => c.id)] });
    const chapterRefs = new Map(graphCards.flatMap(c => c.chapters.map(ch => [ch.id, ch.chapterNo] as const)));
    if (chapterRefs.size !== graphCards.reduce((n, c) => n + c.chapters.length, 0)) throw new Error('Duplicate story graph chapter mapping');
    for (const chapterNo of chapterRefs.values()) if (!chapterNos.has(chapterNo)) throw new Error('Unknown story graph chapter');
    for (const a of [...graph.anchors, ...graph.lockedAnchors]) {
      const chapterNo = chapterRefs.get(a.chapterId), source = chapters.find(c => c.index === (chapterNo ?? 0) - 1);
      if (!source || await sha256Hex(source.content) !== a.contentHash || !verifyEvidence(source.content, a.evidence)) throw new Error(`Invalid story graph evidence: ${a.id}`);
    }
  }
}

export function combineGraphMaterials(parts: Array<Extract<MaterialCard, { type: 'story_graph' }>>): StoryGraph {
  const graph = emptyStoryGraph();
  let preferences = false;
  for (const { graph: part } of parts) {
    for (const key of ['nodes', 'relations', 'anchors', 'secrets', 'growth', 'lockedNodeIds', 'lockedAnchors', 'inbox'] as const) (graph[key] as unknown[]).push(...part[key]);
    if (canonicalJson(part.preferences) !== canonicalJson(emptyStoryGraph().preferences)) {
      if (preferences) throw new Error('Duplicate story graph preferences');
      preferences = true; graph.preferences = part.preferences;
    }
  }
  return StoryGraphSchema.parse(graph);
}
/** Bounded blocks preserve all entries in long works. */
export function graphMaterialCards(graph: StoryGraph, chapters: Array<{ id: string; chapterNo: number }>): MaterialCard[] {
  const result: Array<Extract<MaterialCard, { type: 'story_graph' }>> = [];
  let part: Extract<MaterialCard, { type: 'story_graph' }> = { type: 'story_graph', id: 'story-graph:0', graph: emptyStoryGraph(), chapters };
  part.graph.preferences = graph.preferences;
  let bytes = utf8ByteLength(canonicalJson(part));
  if (bytes > MATERIAL_BLOCK_BYTES) throw new Error('Story graph metadata exceeds material block size');
  const flush = () => { result.push(part); part = { type: 'story_graph', id: `story-graph:${result.length}`, graph: emptyStoryGraph(), chapters: [] }; bytes = utf8ByteLength(canonicalJson(part)); };
  for (const key of ['nodes', 'relations', 'anchors', 'secrets', 'growth', 'lockedNodeIds', 'lockedAnchors', 'inbox'] as const) {
    for (const value of graph[key]) {
      const size = utf8ByteLength(canonicalJson(value));
      if (bytes + size + (part.graph[key].length ? 1 : 0) > MATERIAL_BLOCK_BYTES) flush();
      if (bytes + size > MATERIAL_BLOCK_BYTES) throw new Error('Story graph item exceeds material block size');
      bytes += size + (part.graph[key].length ? 1 : 0);
      (part.graph[key] as unknown[]).push(value);
    }
  }
  flush(); return result;
}
