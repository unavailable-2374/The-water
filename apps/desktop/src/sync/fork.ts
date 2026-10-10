/**
 * Fork protocol (plan §4.4 step 6): POST fork → GET bundle → verify hashes locally →
 * materialize a local novel (storyline rows, chapter plans, imported final versions, bible).
 */
import { nanoid } from 'nanoid';
import { importStoryGraph } from './storyGraphTransfer';
import { getDb, now } from '@/db/db';
import { saveWritingCard } from '@/db/repos/writingRepo';
import { countZh, emptyBible, emptyDerivative, hashChapterContent, hashStoryline, validateMaterialSources, validateCreationMaterials, verifyEvidence, sha256Hex, type NovelBundle, type NovelOrigin, type StorylineDoc, type WritingCardData } from '@the-water/shared';
import { createNovel, purgeNovel, updateNovel, type Novel } from '@/db/repos/novelsRepo';
import { createVersion, upsertChapterPlan } from '@/db/repos/chaptersRepo';
import { buildStorylineDoc, createSnapshot, replaceStorylineRows, setDerivative } from '@/db/repos/storylineRepo';
import { createJob, listJobs } from '@/db/repos/jobsRepo';
import { kick } from '@/jobs/runner';
import { saveBible } from '@/db/repos/bibleRepo';
import { defaultRequirements } from '@/novel/types';
import { listStyleExtractionSources } from '@/novel/styleExtractionSources';
import { emitJobEvent } from '@/jobs/events';
import type { PublicApi } from './api';

export type ForkProgress = (message: string) => void;

/** Recompute every chapter hash and compare with the bundle's manifest. */
export async function verifyBundle(bundle: NovelBundle): Promise<void> {
  if (await hashStoryline(bundle.storyline) !== bundle.version.storylineHash) throw new Error('Storyline hash mismatch');
  const ordered = [...bundle.chapters].sort((a,b) => a.index-b.index);
  if (ordered.some((c,i) => c.index !== i)) throw new Error('Chapter indices must be unique and contiguous');
  if (bundle.bundleVersion === 2) {
    const materials = await validateCreationMaterials(bundle.creationMaterials);
    await validateMaterialSources(materials,bundle.chapters,bundle.storyline);
    for (const { card } of materials.blocks) if (card.type === 'canon') {
      const source = ordered[card.chapterNo - 1];
      if (!source || await sha256Hex(source.content) !== card.contentHash || !verifyEvidence(source.content, card.event.evidence)) throw new Error(`Invalid material evidence: ${card.id}`);
    }
  }
  for (const ch of ordered) {
    const hash = await hashChapterContent(ch.content);
    if (hash !== ch.hash) throw new Error(`第 ${ch.index + 1} 章内容校验失败（hash 不匹配）`);
  }
  if (bundle.chapters.length !== bundle.version.chapterCount) throw new Error('章节数量与版本信息不一致');
}

/** Every imported entity gets a new local ID; source records are archived separately. */
export function remapStoryline(doc: StorylineDoc, ids = new Map<string,string>()): StorylineDoc {
  for (const e of [...doc.characters,...doc.settings,...doc.arcs,...doc.beats]) if (!ids.has(e.id)) ids.set(e.id,nanoid());
  const ref = (id: string) => { const local = ids.get(id); if (!local) throw new Error(`Unknown imported reference: ${id}`); return local; };
  return { ...doc, characters: doc.characters.map(c => ({ ...c, id: ref(c.id), relationships: c.relationships.map(r => ({ ...r,targetId:ref(r.targetId) })) })), settings: doc.settings.map(s => ({ ...s,id:ref(s.id) })), arcs: doc.arcs.map(a => ({ ...a,id:ref(a.id) })), beats: doc.beats.map(b => ({ ...b,id:ref(b.id),arcId:b.arcId ? ref(b.arcId):null,characterIds:b.characterIds.map(ref),settingIds:b.settingIds.map(ref) })), chapters: doc.chapters.map(c => ({ ...c,beatIds:c.beatIds.map(ref),povCharacterId:c.povCharacterId ? ref(c.povCharacterId):null })) };
}
export function remapMaterialCard(card: WritingCardData, ids: Map<string,string>): WritingCardData {
  const ref = (id:string) => { const local = ids.get(id); if (!local) throw new Error(`Unknown imported reference: ${id}`); return local; };
  switch (card.kind) {
    case 'volume': return { ...card,data:{...card.data,arcIds:card.data.arcIds.map(ref)} };
    case 'character': return { ...card,data:{...card.data,characterId:ref(card.data.characterId)} };
    case 'thread': return { ...card,data:{...card.data,characterIds:card.data.characterIds.map(ref)} };
    case 'scene': return { ...card,data:{...card.data,volumeId:card.data.volumeId ? ref(card.data.volumeId):null,povCharacterId:card.data.povCharacterId ? ref(card.data.povCharacterId):null,characterIds:card.data.characterIds.map(ref),threadIds:card.data.threadIds.map(ref),dependencyIds:card.data.dependencyIds.map(ref)} };
    default:return card;
  }
}

/**
 * Fork a remote novel into a new local novel. `versionId` defaults to the current version.
 * Requires an authenticated client.
 */
export async function forkToLocal(client: PublicApi, remoteNovelId: string, versionId?: string, onProgress: ForkProgress = () => undefined): Promise<Novel> {
  onProgress('创建 fork 记录…');
  const { fork } = await client.createFork(remoteNovelId, versionId);

  onProgress('下载小说内容…');
  const bundle = await client.getBundle(remoteNovelId, fork.sourceVersionId, fork.id);

  onProgress('校验章节内容…');
  await verifyBundle(bundle);

  const origin: NovelOrigin = {
    serverUrl: client.baseUrl,
    forkId: fork.id,
    sourceNovelId: bundle.novel.id,
    sourceVersionId: bundle.version.id,
    sourceVersionNumber: bundle.version.versionNumber,
    sourceTitle: bundle.novel.title,
    sourceAuthorId: bundle.novel.author.id,
    sourceAuthorDisplayName: bundle.novel.author.displayName,
    sourceLicense: bundle.novel.license,
    rootNovelId: bundle.lineage.rootNovelId,
    forkedAt: fork.createdAt,
  };

  onProgress('写入本地小说…');
  const novel = await createNovel({
    title: bundle.novel.title,
    premise: bundle.storyline.premise,
    requirements: defaultRequirements(),
    targetChars: bundle.version.charCount,
    status: 'writing',
    origin,
  });

  try {
    const ids = new Map<string,string>();
    const storyline = remapStoryline(bundle.storyline, ids);
    const localChapters = new Map<number,string>();
    await replaceStorylineRows(novel.id, storyline);

    const plans = new Map(storyline.chapters.map((c) => [c.chapterNo, c]));
    const chapters = [...bundle.chapters].sort((a, b) => a.index - b.index);
    for (const ch of chapters) {
      const chapterNo = ch.index + 1;
      const plan = plans.get(chapterNo);
      plans.delete(chapterNo);
      const row = await upsertChapterPlan(novel.id, {
        chapterNo,
        title: ch.title || plan?.title || `第${chapterNo}章`,
        goal: plan?.goal ?? '',
        targetChars: plan?.targetChars || countZh(ch.content),
        povCharacterId: plan?.povCharacterId ?? null,
        beatIds: plan?.beatIds ?? [],
        endHook: plan?.endHook ?? '',
      });
      localChapters.set(chapterNo,row.id);
      await createVersion({ chapterId: row.id, content: ch.content, source: 'imported', status: 'final' });
    }
    // Planned-but-unwritten chapters from the storyline stay as plans.
    for (const plan of plans.values()) {
      const row = await upsertChapterPlan(novel.id, { chapterNo: plan.chapterNo, title: plan.title, goal: plan.goal, targetChars: plan.targetChars, povCharacterId: plan.povCharacterId, beatIds: plan.beatIds, endHook: plan.endHook });
      localChapters.set(plan.chapterNo,row.id);
    }

    if (bundle.bundleVersion === 2) {
      for (const {card} of bundle.creationMaterials.blocks) ids.set(card.id,nanoid());
      for (const {card} of bundle.creationMaterials.blocks) {
        const localId = ids.get(card.id)!;
        if (card.type === 'plan') await saveWritingCard(novel.id,remapMaterialCard(card.card,ids),{ id:localId,chapterId:card.chapterNo ? localChapters.get(card.chapterNo) ?? null:null,order:card.order,confirmed:card.card.kind!=='scene' });
        // Imported evidence is retained verbatim with origin; it is not a local passed review.
        await getDb().execute('INSERT INTO writing_imports(id,novel_id,source_version_id,source_id,local_id,json,created_at) VALUES (?,?,?,?,?,?,?)',[nanoid(),novel.id,bundle.version.id,card.id,localId,JSON.stringify(card),now()]);
      }
      await importStoryGraph(novel.id, bundle.creationMaterials.blocks.flatMap(b => b.card.type === 'story_graph' ? [b.card] : []), ids, localChapters);
    }
    // 二创声明：默认续写、必须保持原著人物性格与叙述腔调；用户可在故事线里改。
    await setDerivative(novel.id, { ...emptyDerivative(), kind: 'sequel', divergencePoint: `原著第 ${chapters.length} 章之后`, mustKeep: ['叙述腔调', '主要人物性格与说话方式', '已发生的事件'] });
    const doc = await buildStorylineDoc(novel.id, bundle.storyline.premise, bundle.storyline.themes);
    await createSnapshot(novel.id, doc, 'import');
    const importedBible=await saveBible(novel.id, chapters.length, bundle.bible ?? emptyBible());
    await getDb().execute('UPDATE story_bible_snapshots SET valid=0 WHERE id=?',[importedBible.id]);

    const updated = await updateNovel(novel.id, {
      meta: { logline: bundle.novel.summary.slice(0, 1000), themes: bundle.storyline.themes, outlineDone: true, tableDone: true },
      remote: null,
    });
    emitJobEvent({ type: 'novel:storylineUpdated', novelId: novel.id });
    // 拆书：原著若已带文风档案则直接复用，否则排一个后台任务提取（docs/writing/README.md §5.1）。
    if (!bundle.storyline.styleProfile && chapters.length > 0) await queueStyleExtraction(novel.id, onProgress);
    return updated ?? novel;
  } catch (e) {
    // 二创失败要把半成品彻底抹掉，而不是丢进回收站
    await purgeNovel(novel.id).catch(() => undefined);
    throw e;
  }
}

/** Best-effort: queue the extract_style job after a fork/import; never fails the import itself. */
export async function queueStyleExtraction(novelId: string, onProgress: ForkProgress = () => undefined): Promise<void> {
  try {
    if (!(await listStyleExtractionSources(novelId)).length) {
      onProgress('正文样本不足，暂不自动提取文风；补充一章超过 200 字的正文后可手动提取。');
      return;
    }
    const active = await listJobs({ novelId, statuses: ['queued', 'running', 'pausing', 'paused', 'awaiting_review'] });
    if (active.length) return;
    onProgress('已排入拆书任务，稍后自动提取原著文风…');
    await createJob({ novelId, type: 'extract_style', params: { auto: true }, providerId: null, steps: [{ kind: 'extract_style', chapterId: null, input: {} }] });
    kick();
  } catch (e) {
    console.warn('queue style extraction failed', e);
  }
}
