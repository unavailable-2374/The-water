import { nanoid } from "nanoid";
import {
  anchorEvidence,
  canonicalJson,
  combineGraphMaterials,
  emptyStoryGraph,
  graphMaterialCards,
  normalizeChapterText,
  remapStoryGraph,
  sha256Hex,
  type MaterialCard,
} from "@the-water/shared";
import {
  getStoryGraph,
  graphCas,
  validateGraph,
} from "@/db/repos/storyGraphRepo";
import { getDb } from "@/db/db";
import { getChapter, getVersion, listChapters } from "@/db/repos/chaptersRepo";

export async function exportStoryGraph(
  novelId: string,
  published: Map<number, string>,
): Promise<MaterialCard[]> {
  const { graph } = await getStoryGraph(novelId);
  if (canonicalJson(graph) === canonicalJson(emptyStoryGraph())) return [];
  const copy = structuredClone(graph),
    chapters = await listChapters(novelId);
  copy.inbox = [];
  copy.relations = copy.relations.filter((r) => r.status === "confirmed");
  copy.anchors = copy.anchors.filter((a) => a.status === "confirmed");
  if (!copy.preferences.confirmed)
    copy.preferences = emptyStoryGraph().preferences;
  for (const a of [...copy.anchors, ...copy.lockedAnchors]) {
    const chapter = chapters.find((c) => c.id === a.chapterId),
      content = chapter ? published.get(chapter.chapterNo) : undefined;
    const version = chapter?.committedVersionId
      ? await getVersion(chapter.committedVersionId)
      : null;
    if (
      content === undefined ||
      !version ||
      version.id !== a.versionId ||
      version.contentHash !== a.contentHash
    )
      throw new Error("共享结构包含过期的原文关联，请重新关联已提交正文");
    a.evidence = anchorEvidence(content, {
      ...a.evidence,
      quote: normalizeChapterText(a.evidence.quote),
    });
    a.contentHash = await sha256Hex(content);
  }
  return graphMaterialCards(
    copy,
    chapters.map((c) => ({ id: c.id, chapterNo: c.chapterNo })),
  );
}
export async function importStoryGraph(
  novelId: string,
  parts: Array<Extract<MaterialCard, { type: "story_graph" }>>,
  ids: Map<string, string>,
  chapters: Map<number, string>,
) {
  if (!parts.length) return;
  const graph = combineGraphMaterials(parts);
  for (const c of parts.flatMap((p) => p.chapters)) {
    const local = chapters.get(c.chapterNo);
    if (!local) throw new Error("Unknown graph chapter");
    ids.set(c.id, local);
  }
  for (const item of [
    ...graph.relations,
    ...graph.anchors,
    ...graph.lockedAnchors,
    ...graph.secrets,
    ...graph.growth,
    ...graph.inbox,
  ])
    if (!ids.has(item.id)) ids.set(item.id, nanoid());
  for (const a of [...graph.anchors, ...graph.lockedAnchors]) {
    const chapter = await getChapter(ids.get(a.chapterId) ?? ""),
      version = chapter?.currentVersionId
        ? await getVersion(chapter.currentVersionId)
        : null;
    if (!version || version.contentHash !== a.contentHash)
      throw new Error("Imported graph evidence differs from local prose");
    ids.set(a.versionId, version.id);
  }
  const mapped = remapStoryGraph(graph, (id) => {
    const value = ids.get(id);
    if (!value) throw new Error(`Unknown imported graph reference: ${id}`);
    return value;
  });
  await validateGraph(novelId, mapped);
  await getDb().atomic(graphCas(novelId, 0, mapped));
}
