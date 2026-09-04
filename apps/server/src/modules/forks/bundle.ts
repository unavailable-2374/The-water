import { eq } from 'drizzle-orm';
import { LIMITS, type NovelBundleV1 } from '@the-water/shared';
import type { AppDeps } from '../../context';
import { blobs, versionChapters } from '../../db/schema';
import { ApiError, forbidden, notFound } from '../../lib/errors';
import { iso, isoOrNull } from '../../lib/time';
import { authorOf, isPubliclyViewable, loadViewableNovel, type Viewer } from '../novels/service';
import { resolveVersion } from '../versions/service';
import { findFork } from './service';

/**
 * 导出 NovelBundleV1。带 forkId 时必须是当前用户的 fork 且指向该小说（fork 记录即授权，
 * 即使作者后来关闭了二创也可拉取）。超过 BUNDLE_MAX_CHARS 返回 413，客户端应改用分页拉章节。
 */
export function buildBundle(deps: AppDeps, novelId: string, vid: string, viewer: Viewer, forkId: string | undefined): NovelBundleV1 {
  const novel = loadViewableNovel(deps, novelId, viewer);
  let fork: { id: string } | null = null;
  let version = resolveVersion(deps, novel, vid, viewer);

  if (forkId) {
    if (!viewer) throw forbidden('需要登录以使用 fork 记录');
    const f = findFork(deps, forkId);
    if (!f || f.userId !== viewer.id || f.sourceNovelId !== novelId) throw notFound('fork 记录');
    fork = { id: f.id };
    if (vid === 'current') version = resolveVersion(deps, novel, f.sourceVersionId, viewer);
  } else if (!isPubliclyViewable(novel) && !(viewer && (viewer.id === novel.authorId || viewer.role === 'admin'))) {
    throw notFound('小说');
  }
  if (version.status !== 'committed') throw notFound('版本');
  if (version.charCount > LIMITS.BUNDLE_MAX_CHARS) {
    throw new ApiError('PAYLOAD_TOO_LARGE', '作品过大，请分页拉取章节', {
      charCount: version.charCount,
      limit: LIMITS.BUNDLE_MAX_CHARS,
    });
  }

  const rows = deps.db
    .select({ index: versionChapters.index, title: versionChapters.title, hash: versionChapters.blobHash, content: blobs.content })
    .from(versionChapters)
    .innerJoin(blobs, eq(blobs.hash, versionChapters.blobHash))
    .where(eq(versionChapters.versionId, version.id))
    .orderBy(versionChapters.index)
    .all();

  const author = authorOf(deps, novel.authorId);
  return {
    bundleVersion: 1,
    exportedAt: iso(deps.clock.now()),
    server: { baseUrl: deps.env.publicBaseUrl },
    novel: {
      id: novel.id,
      title: novel.title,
      summary: novel.summary,
      tags: novel.tags,
      language: novel.language,
      writingStatus: novel.writingStatus,
      license: novel.license,
      allowDerivatives: novel.allowDerivatives,
      author,
    },
    version: {
      id: version.id,
      versionNumber: version.versionNumber,
      committedAt: isoOrNull(version.committedAt),
      storylineHash: version.storylineHash,
      chapterCount: version.chapterCount,
      charCount: version.charCount,
    },
    storyline: version.storyline,
    bible: version.bible ?? null,
    chapters: rows,
    lineage: {
      sourceNovelId: novel.sourceNovelId,
      sourceVersionId: novel.sourceVersionId,
      rootNovelId: novel.rootNovelId,
      depth: novel.depth,
    },
    fork,
  };
}
