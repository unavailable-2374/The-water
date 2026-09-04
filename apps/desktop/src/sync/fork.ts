/**
 * Fork protocol (plan §4.4 step 6): POST fork → GET bundle → verify hashes locally →
 * materialize a local novel (storyline rows, chapter plans, imported final versions, bible).
 */
import { countZh, emptyBible, emptyDerivative, hashChapterContent, type NovelBundleV1, type NovelOrigin } from '@the-water/shared';
import { createNovel, purgeNovel, updateNovel, type Novel } from '@/db/repos/novelsRepo';
import { createVersion, upsertChapterPlan } from '@/db/repos/chaptersRepo';
import { buildStorylineDoc, createSnapshot, replaceStorylineRows, setDerivative } from '@/db/repos/storylineRepo';
import { createJob, listJobs } from '@/db/repos/jobsRepo';
import { kick } from '@/jobs/runner';
import { saveBible } from '@/db/repos/bibleRepo';
import { defaultRequirements } from '@/novel/types';
import { emitJobEvent } from '@/jobs/events';
import type { PublicApi } from './api';

export type ForkProgress = (message: string) => void;

/** Recompute every chapter hash and compare with the bundle's manifest. */
export async function verifyBundle(bundle: NovelBundleV1): Promise<void> {
  for (const ch of bundle.chapters) {
    const hash = await hashChapterContent(ch.content);
    if (hash !== ch.hash) throw new Error(`第 ${ch.index + 1} 章内容校验失败（hash 不匹配）`);
  }
  if (bundle.chapters.length !== bundle.version.chapterCount) throw new Error('章节数量与版本信息不一致');
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
    await replaceStorylineRows(novel.id, bundle.storyline);

    const plans = new Map(bundle.storyline.chapters.map((c) => [c.chapterNo, c]));
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
      await createVersion({ chapterId: row.id, content: ch.content, source: 'imported', status: 'final' });
    }
    // Planned-but-unwritten chapters from the storyline stay as plans.
    for (const plan of plans.values()) {
      await upsertChapterPlan(novel.id, { chapterNo: plan.chapterNo, title: plan.title, goal: plan.goal, targetChars: plan.targetChars, povCharacterId: plan.povCharacterId, beatIds: plan.beatIds, endHook: plan.endHook });
    }

    // 二创声明：默认续写、必须保持原著人物性格与叙述腔调；用户可在故事线里改。
    await setDerivative(novel.id, { ...emptyDerivative(), kind: 'sequel', divergencePoint: `原著第 ${chapters.length} 章之后`, mustKeep: ['叙述腔调', '主要人物性格与说话方式', '已发生的事件'] });
    const doc = await buildStorylineDoc(novel.id, bundle.storyline.premise, bundle.storyline.themes);
    await createSnapshot(novel.id, doc, 'import');
    await saveBible(novel.id, chapters.length, bundle.bible ?? emptyBible());

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
    const active = await listJobs({ novelId, statuses: ['queued', 'running', 'pausing', 'paused'] });
    if (active.length) return;
    onProgress('已排入拆书任务，稍后自动提取原著文风…');
    await createJob({ novelId, type: 'extract_style', params: { auto: true }, providerId: null, steps: [{ kind: 'extract_style', chapterId: null, input: {} }] });
    kick();
  } catch (e) {
    console.warn('queue style extraction failed', e);
  }
}
