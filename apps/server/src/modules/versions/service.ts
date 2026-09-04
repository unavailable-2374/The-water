import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  LIMITS,
  hashStoryline,
  utf8ByteLength,
  type CommitVersionResponse,
  type CreateVersionRequest,
  type CreateVersionResponse,
  type Page,
  type VersionSummary,
} from '@the-water/shared';
import type { AppDeps, AuthUser } from '../../context';
import {
  novels,
  novelVersions,
  versionChapters,
  type ChapterManifestRow,
  type NovelRow,
  type NovelVersionRow,
} from '../../db/schema';
import { ApiError, conflict, forbidden, notFound, validation } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { DAY } from '../../lib/time';
import { findMissingHashes, loadBlobs } from '../blobs/service';
import { recordActivity } from '../feed/service';
import { awardPublish } from '../incentive/service';
import { toVersionSummary } from '../novels/dto';
import { buildNovelDetail, canView, findNovelRow, isOwnerOrAdmin, loadOwnedNovel, type Viewer } from '../novels/service';

export const DRAFT_TTL_MS = DAY;

function validateManifest(chapters: CreateVersionRequest['chapters']): ChapterManifestRow[] {
  const sorted = [...chapters].sort((a, b) => a.index - b.index);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i]!.index !== i) throw validation('章节 index 必须从 0 开始连续', { at: i, got: sorted[i]!.index });
  }
  const total = sorted.reduce((s, c) => s + c.charCount, 0);
  if (total > LIMITS.MAX_CHARS_PER_VERSION) throw validation(`单版本字数不能超过 ${LIMITS.MAX_CHARS_PER_VERSION}`);
  return sorted.map((c) => ({ index: c.index, title: c.title, hash: c.hash, charCount: c.charCount }));
}

function manifestHashes(m: ChapterManifestRow[]): string[] {
  return m.map((c) => c.hash);
}

export function findVersion(deps: AppDeps, novelId: string, vid: string): NovelVersionRow | undefined {
  return deps.db
    .select()
    .from(novelVersions)
    .where(and(eq(novelVersions.id, vid), eq(novelVersions.novelId, novelId)))
    .get();
}

/** `:vid` 可为 current；返回可见版本（草稿/中止仅作者可见）。 */
export function resolveVersion(deps: AppDeps, novel: NovelRow, vid: string, viewer: Viewer): NovelVersionRow {
  const id = vid === 'current' ? novel.currentVersionId : vid;
  if (!id) throw notFound('版本');
  const v = findVersion(deps, novel.id, id);
  if (!v) throw notFound('版本');
  if (v.status !== 'committed' && !isOwnerOrAdmin(novel, viewer)) throw notFound('版本');
  return v;
}

export async function createDraft(
  deps: AppDeps,
  user: AuthUser,
  novelId: string,
  idempotencyKey: string,
  req: CreateVersionRequest,
): Promise<{ response: CreateVersionResponse; created: boolean }> {
  const novel = loadOwnedNovel(deps, novelId, user);

  const existing = deps.db
    .select()
    .from(novelVersions)
    .where(and(eq(novelVersions.novelId, novelId), eq(novelVersions.idempotencyKey, idempotencyKey)))
    .get();
  if (existing) {
    const missing = existing.status === 'draft' ? findMissingHashes(deps, manifestHashes(existing.manifest)) : [];
    return { response: { version: toVersionSummary(existing), missingHashes: missing }, created: false };
  }

  const drafts = deps.db
    .select({ c: sql<number>`count(*)` })
    .from(novelVersions)
    .innerJoin(novels, eq(novels.id, novelVersions.novelId))
    .where(and(eq(novels.authorId, novel.authorId), eq(novelVersions.status, 'draft')))
    .get();
  if ((drafts?.c ?? 0) >= LIMITS.MAX_DRAFTS_PER_USER) throw conflict(`未提交的草稿版本过多（上限 ${LIMITS.MAX_DRAFTS_PER_USER}），请先提交或删除`);

  const manifest = validateManifest(req.chapters);
  if (utf8ByteLength(JSON.stringify(req.storyline)) > LIMITS.MAX_STORYLINE_BYTES) throw validation('故事线过大');
  if (req.bible && utf8ByteLength(JSON.stringify(req.bible)) > LIMITS.MAX_BIBLE_BYTES) throw validation('故事圣经过大');
  const storylineHash = await hashStoryline(req.storyline);
  const now = deps.clock.now();
  const row: typeof novelVersions.$inferInsert = {
    id: newId(),
    novelId,
    versionNumber: 0,
    status: 'draft',
    baseVersionId: novel.currentVersionId,
    idempotencyKey,
    storyline: req.storyline,
    storylineHash,
    bible: req.bible,
    manifest,
    changeNote: req.changeNote ?? null,
    chapterCount: manifest.length,
    charCount: manifest.reduce((s, c) => s + c.charCount, 0),
    createdAt: now,
    committedAt: null,
  };
  try {
    deps.db.insert(novelVersions).values(row).run();
  } catch (e) {
    // 并发同 key：回读已有草稿。
    if (String(e).includes('UNIQUE')) {
      const again = deps.db
        .select()
        .from(novelVersions)
        .where(and(eq(novelVersions.novelId, novelId), eq(novelVersions.idempotencyKey, idempotencyKey)))
        .get();
      if (again) {
        return {
          response: { version: toVersionSummary(again), missingHashes: findMissingHashes(deps, manifestHashes(again.manifest)) },
          created: false,
        };
      }
    }
    throw e;
  }
  const inserted = findVersion(deps, novelId, row.id!)!;
  return {
    response: { version: toVersionSummary(inserted), missingHashes: findMissingHashes(deps, manifestHashes(manifest)) },
    created: true,
  };
}

export function getVersionStatus(
  deps: AppDeps,
  novelId: string,
  vid: string,
  viewer: Viewer,
): { version: VersionSummary; missingHashes?: string[] } {
  const novel = findNovelRow(deps, novelId);
  if (!novel || !canView(novel, viewer)) throw notFound('小说');
  const v = resolveVersion(deps, novel, vid, viewer);
  if (v.status === 'draft' && isOwnerOrAdmin(novel, viewer)) {
    return { version: toVersionSummary(v), missingHashes: findMissingHashes(deps, manifestHashes(v.manifest)) };
  }
  return { version: toVersionSummary(v) };
}

export function listVersions(deps: AppDeps, novelId: string, viewer: Viewer): Page<VersionSummary> {
  const novel = findNovelRow(deps, novelId);
  if (!novel || !canView(novel, viewer)) throw notFound('小说');
  const owner = isOwnerOrAdmin(novel, viewer);
  const where = owner
    ? eq(novelVersions.novelId, novelId)
    : and(eq(novelVersions.novelId, novelId), eq(novelVersions.status, 'committed'));
  const rows = deps.db
    .select()
    .from(novelVersions)
    .where(where)
    .orderBy(desc(novelVersions.versionNumber), desc(novelVersions.createdAt))
    .all();
  return { items: rows.map(toVersionSummary), nextCursor: null };
}

/** 仅允许中止草稿；已提交版本不可删除（不可变）。 */
export function abortDraft(deps: AppDeps, user: AuthUser, novelId: string, vid: string): void {
  const novel = loadOwnedNovel(deps, novelId, user);
  const v = resolveVersion(deps, novel, vid, user);
  if (v.status === 'committed') throw forbidden('已提交的版本不可删除');
  deps.db.update(novelVersions).set({ status: 'aborted' }).where(eq(novelVersions.id, v.id)).run();
}

export async function commitVersion(deps: AppDeps, user: AuthUser, novelId: string, vid: string): Promise<CommitVersionResponse> {
  const novel = loadOwnedNovel(deps, novelId, user);
  const v = resolveVersion(deps, novel, vid, user);

  if (v.status === 'committed') {
    return { version: toVersionSummary(v), novel: buildNovelDetail(deps, findNovelRow(deps, novelId)!, user) };
  }
  if (v.status !== 'draft') throw new ApiError('VERSION_NOT_DRAFT', '该版本已中止，不能提交');

  const hashes = manifestHashes(v.manifest);
  const missing = findMissingHashes(deps, hashes);
  if (missing.length) {
    throw new ApiError('BLOBS_MISSING', `尚有 ${missing.length} 个章节内容未上传`, { missingHashes: missing });
  }

  const blobMap = loadBlobs(deps, hashes);
  const chapters = v.manifest.map((m) => {
    const b = blobMap.get(m.hash)!;
    return { index: m.index, title: m.title, hash: m.hash, charCount: b.charCount, content: b.content };
  });
  const totalChars = chapters.reduce((s, c) => s + c.charCount, 0);
  if (totalChars > LIMITS.MAX_CHARS_PER_VERSION) throw validation(`单版本字数不能超过 ${LIMITS.MAX_CHARS_PER_VERSION}`);

  const moderation = await deps.moderator.check({
    novel: { id: novel.id, title: novel.title, summary: novel.summary, tags: novel.tags },
    storyline: v.storyline,
    chapters: chapters.map((c) => ({ index: c.index, title: c.title, content: c.content })),
  });

  const now = deps.clock.now();
  deps.db.transaction((tx) => {
    // 事务内重读，防止并发双提交。
    const fresh = tx.select().from(novelVersions).where(eq(novelVersions.id, v.id)).get();
    if (!fresh || fresh.status !== 'draft') throw new ApiError('VERSION_NOT_DRAFT', '版本状态已变化，请重试');
    const maxRow = tx
      .select({ m: sql<number>`coalesce(max(${novelVersions.versionNumber}), 0)` })
      .from(novelVersions)
      .where(and(eq(novelVersions.novelId, novelId), eq(novelVersions.status, 'committed')))
      .get();
    const versionNumber = (maxRow?.m ?? 0) + 1;

    const CHUNK = 100;
    for (let i = 0; i < chapters.length; i += CHUNK) {
      tx.insert(versionChapters)
        .values(
          chapters.slice(i, i + CHUNK).map((c) => ({
            versionId: v.id,
            index: c.index,
            title: c.title,
            blobHash: c.hash,
            charCount: c.charCount,
          })),
        )
        .run();
    }
    tx.update(novelVersions)
      .set({ status: 'committed', versionNumber, committedAt: now, chapterCount: chapters.length, charCount: totalChars })
      .where(eq(novelVersions.id, v.id))
      .run();

    const novelSet: Partial<typeof novels.$inferInsert> = {
      currentVersionId: v.id,
      chapterCount: chapters.length,
      charCount: totalChars,
      lastPublishedAt: now,
      updatedAt: now,
      visibility: novel.publishVisibility,
    };
    if (!novel.publishedAt) novelSet.publishedAt = now;
    if (!moderation.ok) {
      novelSet.moderationStatus = 'hidden';
      novelSet.moderationNote = moderation.reason;
    } else if (novel.moderationStatus === 'hidden') {
      // 之前因审核挂起的小说，新版本通过审核后恢复。
      novelSet.moderationStatus = 'ok';
      novelSet.moderationNote = null;
    }
    tx.update(novels).set(novelSet).where(eq(novels.id, novelId)).run();

    // 记动态与积分放在小说行更新之后：徽章统计要按"已经公开"的状态算。
    // 审核未通过时动态照记，读取端因 publicListWhere() 看不到，恢复审核后自动出现。
    recordActivity(deps, tx, {
      actorId: novel.authorId,
      kind: novel.publishedAt ? 'version_published' : 'novel_published',
      novelId,
      versionId: v.id,
    });
    awardPublish(deps, tx, novel, !novel.publishedAt);
  });

  const committed = findVersion(deps, novelId, v.id)!;
  return { version: toVersionSummary(committed), novel: buildNovelDetail(deps, findNovelRow(deps, novelId)!, user) };
}

/** 清理超过 24 小时未提交的草稿。 */
export function gcDrafts(deps: AppDeps): number {
  const cutoff = new Date(deps.clock.now().getTime() - DRAFT_TTL_MS);
  const stale = deps.db
    .select({ id: novelVersions.id })
    .from(novelVersions)
    .where(and(inArray(novelVersions.status, ['draft', 'aborted']), lt(novelVersions.createdAt, cutoff)))
    .all();
  if (!stale.length) return 0;
  deps.db
    .delete(novelVersions)
    .where(inArray(novelVersions.id, stale.map((s) => s.id)))
    .run();
  return stale.length;
}

export function listVersionChapters(deps: AppDeps, versionId: string) {
  return deps.db.select().from(versionChapters).where(eq(versionChapters.versionId, versionId)).orderBy(asc(versionChapters.index)).all();
}
