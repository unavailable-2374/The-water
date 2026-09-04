import { and, desc, eq, isNotNull, isNull, lt, or, type SQL } from 'drizzle-orm';
import type { BrowseQuery, ChapterContent, ChapterMeta, NovelSummary, Page } from '@the-water/shared';
import type { AppDeps } from '../../context';
import { blobs, novels, users, versionChapters, type NovelRow } from '../../db/schema';
import { hasTag, titleOrSummaryContains } from '../../db/search';
import { decodeCursor, encodeCursor } from '../../lib/cursor';
import { notFound } from '../../lib/errors';
import { toNovelSummary } from '../novels/dto';
import { loadViewableNovel, type Viewer } from '../novels/service';
import { notBlockedEitherWay } from '../users/blocking';
import { listVersionChapters, resolveVersion } from '../versions/service';

/** 公开列表的基础条件：公开、审核通过、未删除、至少有一个已提交版本。 */
export function publicListWhere(): SQL {
  return and(
    eq(novels.visibility, 'public'),
    eq(novels.moderationStatus, 'ok'),
    isNull(novels.deletedAt),
    isNotNull(novels.currentVersionId),
  )!;
}

type SortKey = BrowseQuery['sort'];

function sortColumn(sort: SortKey) {
  switch (sort) {
    case 'popular':
      return novels.viewCount;
    case 'likes':
      return novels.likeCount;
    case 'forks':
      return novels.forkCount;
    default:
      return novels.lastPublishedAt;
  }
}

function sortValue(n: NovelRow, sort: SortKey): number {
  switch (sort) {
    case 'popular':
      return n.viewCount;
    case 'likes':
      return n.likeCount;
    case 'forks':
      return n.forkCount;
    default:
      return n.lastPublishedAt?.getTime() ?? 0;
  }
}

export function browseNovels(deps: AppDeps, q: BrowseQuery, viewer: Viewer = null): Page<NovelSummary> {
  const conds: SQL[] = [publicListWhere()];
  // 屏蔽是双向的：我屏蔽的人和屏蔽我的人，作品都不在我的列表里。
  if (viewer) conds.push(notBlockedEitherWay(deps, viewer.id, novels.authorId));
  if (q.q) conds.push(titleOrSummaryContains(q.q));
  if (q.tag) conds.push(hasTag(q.tag));
  if (q.license) conds.push(eq(novels.license, q.license));
  if (q.writingStatus) conds.push(eq(novels.writingStatus, q.writingStatus));
  if (q.allowDerivatives !== undefined) conds.push(eq(novels.allowDerivatives, q.allowDerivatives));
  if (q.originalsOnly) conds.push(isNull(novels.sourceNovelId));

  const col = sortColumn(q.sort);
  const cursor = decodeCursor(q.cursor);
  if (cursor) {
    const v = q.sort === 'latest' ? new Date(cursor.v) : cursor.v;
    // 列类型随排序而变，此处按运行时值比较。
    conds.push(or(lt(col as never, v as never), and(eq(col as never, v as never), lt(novels.id, cursor.id)))!);
  }

  const rows = deps.db
    .select({ n: novels, author: { id: users.id, displayName: users.displayName, handle: users.handle } })
    .from(novels)
    .innerJoin(users, eq(users.id, novels.authorId))
    .where(and(...conds))
    .orderBy(desc(col), desc(novels.id))
    .limit(q.limit + 1)
    .all();
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => toNovelSummary(r.n, r.author)),
    nextCursor: rows.length > q.limit && last ? encodeCursor({ v: sortValue(last.n, q.sort), id: last.n.id }) : null,
  };
}

/** 网页首页：最新 N 本。 */
export function latestNovels(deps: AppDeps, limit: number): NovelSummary[] {
  return browseNovels(deps, { sort: 'latest', limit }).items;
}

export function getStoryline(deps: AppDeps, novelId: string, vid: string, viewer: Viewer) {
  const novel = loadViewableNovel(deps, novelId, viewer);
  const v = resolveVersion(deps, novel, vid, viewer);
  return { storyline: v.storyline, bible: v.bible ?? null, storylineHash: v.storylineHash };
}

export function listChapters(
  deps: AppDeps,
  novelId: string,
  vid: string,
  viewer: Viewer,
  from: number,
  limit: number,
): { items: ChapterMeta[]; total: number } {
  const novel = loadViewableNovel(deps, novelId, viewer);
  const v = resolveVersion(deps, novel, vid, viewer);
  const rows = v.status === 'committed' ? listVersionChapters(deps, v.id) : [];
  const items = rows
    .filter((r) => r.index >= from)
    .slice(0, limit)
    .map((r) => ({ index: r.index, title: r.title, charCount: r.charCount, hash: r.blobHash }));
  return { items, total: rows.length };
}

export function getChapter(deps: AppDeps, novelId: string, vid: string, index: number, viewer: Viewer): ChapterContent {
  const novel = loadViewableNovel(deps, novelId, viewer);
  const v = resolveVersion(deps, novel, vid, viewer);
  if (v.status !== 'committed') throw notFound('章节');
  const row = deps.db
    .select({ vc: versionChapters, content: blobs.content })
    .from(versionChapters)
    .innerJoin(blobs, eq(blobs.hash, versionChapters.blobHash))
    .where(and(eq(versionChapters.versionId, v.id), eq(versionChapters.index, index)))
    .get();
  if (!row) throw notFound('章节');
  return {
    index: row.vc.index,
    title: row.vc.title,
    charCount: row.vc.charCount,
    hash: row.vc.blobHash,
    content: row.content,
    prev: index > 0 ? index - 1 : null,
    next: index + 1 < v.chapterCount ? index + 1 : null,
  };
}
