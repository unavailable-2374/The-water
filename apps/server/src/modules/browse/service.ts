import { and, count, desc, eq, isNotNull, isNull, lt, or, type SQL } from 'drizzle-orm';
import type { BrowseQuery, ChapterContent, ChapterMeta, NovelSummary, Page } from '@the-water/shared';
import type { AppDeps } from '../../context';
import { blobs, novels, users, versionChapters, type NovelRow } from '../../db/schema';
import { titleOrSummaryContains } from '../../db/search';
import { decodeCursor, encodeCursor } from '../../lib/cursor';
import { notFound } from '../../lib/errors';
import { toNovelSummary } from '../novels/dto';
import { hasNormalizedTag } from '../novels/tags';
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

/**
 * §4.6：`popular / likes / forks` 三种排序的主键是可变计数器，只靠 (计数, id) 做游标，
 * 同一计数值内的顺序会随着计数变化而漂移。这里把不可变的 `lastPublishedAt` 插进排序键中间，
 * 变成 (计数, 发布时间, id) 三段全序 —— 计数相同的一批作品从此有稳定顺序，翻页不会来回跳。
 *
 * KeysetCursor 只有 (v, id) 两段，所以把后两段打包进 id 字段：`${发布时间ms}|${小说id}`。
 * `latest` 排序本身就以 lastPublishedAt 为主键，游标格式保持不变，旧游标继续可用。
 *
 * 仍然存在的限制：某本书的计数在两次翻页之间跨过了游标值，它还是会被跳过或重复 ——
 * 那需要把排名物化成快照，不是游标层能解决的，留作后续。
 */
const CURSOR_SEP = '|';

function packTail(n: NovelRow): string {
  return `${n.lastPublishedAt?.getTime() ?? 0}${CURSOR_SEP}${n.id}`;
}

function unpackTail(raw: string): { publishedAtMs: number; id: string } | null {
  const at = raw.indexOf(CURSOR_SEP);
  if (at < 0) return null;
  const ms = Number(raw.slice(0, at));
  const id = raw.slice(at + 1);
  if (!Number.isFinite(ms) || !id) return null;
  return { publishedAtMs: ms, id };
}

export function browseNovels(deps: AppDeps, q: BrowseQuery, viewer: Viewer = null): Page<NovelSummary> {
  const conds: SQL[] = [publicListWhere()];
  // 屏蔽是双向的：我屏蔽的人和屏蔽我的人，作品都不在我的列表里。
  if (viewer) conds.push(notBlockedEitherWay(deps, viewer.id, novels.authorId));
  if (q.q) conds.push(titleOrSummaryContains(q.q));
  // 标签过滤走归一化后的 novel_tags 投影，「玄幻」和「 玄幻 」不再是两个标签（§3.4）。
  if (q.tag) conds.push(hasNormalizedTag(deps, q.tag));
  if (q.license) conds.push(eq(novels.license, q.license));
  if (q.writingStatus) conds.push(eq(novels.writingStatus, q.writingStatus));
  if (q.allowDerivatives !== undefined) conds.push(eq(novels.allowDerivatives, q.allowDerivatives));
  if (q.originalsOnly) conds.push(isNull(novels.sourceNovelId));

  const col = sortColumn(q.sort);
  const cursor = decodeCursor(q.cursor);
  const byCounter = q.sort !== 'latest';
  if (cursor) {
    if (byCounter) {
      const tail = unpackTail(cursor.id);
      const tailDate = new Date(tail?.publishedAtMs ?? 0);
      const tailId = tail?.id ?? cursor.id;
      conds.push(
        or(
          lt(col as never, cursor.v as never),
          and(
            eq(col as never, cursor.v as never),
            or(
              lt(novels.lastPublishedAt, tailDate),
              and(eq(novels.lastPublishedAt, tailDate), lt(novels.id, tailId)),
            ),
          ),
        )!,
      );
    } else {
      conds.push(
        or(
          lt(novels.lastPublishedAt, new Date(cursor.v)),
          and(eq(novels.lastPublishedAt, new Date(cursor.v)), lt(novels.id, cursor.id)),
        )!,
      );
    }
  }

  const rows = deps.db
    .select({ n: novels, author: { id: users.id, displayName: users.displayName, handle: users.handle } })
    .from(novels)
    .innerJoin(users, eq(users.id, novels.authorId))
    .where(and(...conds))
    .orderBy(...(byCounter ? [desc(col), desc(novels.lastPublishedAt), desc(novels.id)] : [desc(col), desc(novels.id)]))
    .limit(q.limit + 1)
    .all();
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > q.limit && last
      ? encodeCursor({ v: sortValue(last.n, q.sort), id: byCounter ? packTail(last.n) : last.n.id })
      : null;
  return { items: page.map((r) => toNovelSummary(r.n, r.author)), nextCursor };
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


// ---- 偏移分页（供服务端渲染的网页使用）----

export interface OffsetPage<T> {
  items: T[];
  total: number;
  /** 从 1 开始。 */
  page: number;
  perPage: number;
  pageCount: number;
}

/**
 * 与 `browseNovels` 同一套可见性与筛选条件，但换成偏移分页 + 总数。
 *
 * 网页需要「第 N 页 / 共 M 页」这种能被爬虫抓取的稳定页码链接，游标分页给不了总数；
 * 客户端仍然应该用 `browseNovels` 的游标分页（无限滚动、翻页不漂移）。
 * 两者共用筛选条件，避免网页和 API 对「哪些作品算公开」给出不同答案。
 */
export function browseNovelsOffset(
  deps: AppDeps,
  q: Omit<BrowseQuery, 'cursor' | 'limit'>,
  page: number,
  perPage: number,
  viewer: Viewer = null,
): OffsetPage<NovelSummary> {
  const conds: SQL[] = [publicListWhere()];
  if (viewer) conds.push(notBlockedEitherWay(deps, viewer.id, novels.authorId));
  if (q.q) conds.push(titleOrSummaryContains(q.q));
  if (q.tag) conds.push(hasNormalizedTag(deps, q.tag));
  if (q.license) conds.push(eq(novels.license, q.license));
  if (q.writingStatus) conds.push(eq(novels.writingStatus, q.writingStatus));
  if (q.allowDerivatives !== undefined) conds.push(eq(novels.allowDerivatives, q.allowDerivatives));
  if (q.originalsOnly) conds.push(isNull(novels.sourceNovelId));

  const total = deps.db.select({ c: count() }).from(novels).where(and(...conds)).get()?.c ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, page), pageCount);
  const col = sortColumn(q.sort);
  const rows = deps.db
    .select({ n: novels, author: { id: users.id, displayName: users.displayName, handle: users.handle } })
    .from(novels)
    .innerJoin(users, eq(users.id, novels.authorId))
    .where(and(...conds))
    // 与游标分页同一套排序键：计数排序也带上不可变的 lastPublishedAt 做次键。
    .orderBy(...(q.sort === 'latest' ? [desc(col), desc(novels.id)] : [desc(col), desc(novels.lastPublishedAt), desc(novels.id)]))
    .limit(perPage)
    .offset((current - 1) * perPage)
    .all();
  return { items: rows.map((r) => toNovelSummary(r.n, r.author)), total, page: current, perPage, pageCount };
}
