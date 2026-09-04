/**
 * 网页层的只读查询。
 *
 * 网页需要「第 N 页 / 共 M 页」这种可被爬虫抓取的偏移分页，
 * 而 `modules/browse` 与 `modules/users` 对外暴露的是游标分页（适合客户端无限滚动，
 * 但无法生成稳定的页码链接、也拿不到总数）。因此这里在 web 层自己写偏移查询，
 * 复用 `publicListWhere()` 等既有可见性条件，保证与 API 的可见性判定完全一致。
 *
 * 将来若 `modules/browse` 提供了偏移分页与标签聚合，本文件可以整体下沉过去。
 */
import { and, count, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { NovelSummary, TagSummary } from '@the-water/shared';
import type { AppDeps } from '../context';
import { titleOrSummaryContains } from '../db/search';
import { hasNormalizedTag, listTags, popularTags as popularTagsFromDirectory } from '../modules/novels/tags';
import { novels, users } from '../db/schema';
import { publicListWhere } from '../modules/browse/service';
import { toNovelSummary } from '../modules/novels/dto';

export type WebSort = 'latest' | 'popular' | 'likes' | 'forks';
export const WEB_SORTS: readonly WebSort[] = ['latest', 'popular', 'likes', 'forks'];
export const SORT_LABELS: Record<WebSort, string> = {
  latest: '最新更新',
  popular: '最多阅读',
  likes: '最多点赞',
  forks: '最多二创',
};

export interface WebBrowseFilter {
  sort: WebSort;
  q?: string;
  tag?: string;
  license?: NovelSummary['license'];
  writingStatus?: NovelSummary['writingStatus'];
  originalsOnly?: boolean;
}

export interface OffsetPage<T> {
  items: T[];
  total: number;
  /** 从 1 开始。 */
  page: number;
  perPage: number;
  pageCount: number;
}

function sortColumn(sort: WebSort) {
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

function filterConds(deps: AppDeps, f: WebBrowseFilter): SQL[] {
  const conds: SQL[] = [publicListWhere()];
  if (f.q) conds.push(titleOrSummaryContains(f.q));
  // 与浏览接口同口径：走 novel_tags.slug，而不是扫 novels.tags 的原始 JSON。
  // 两边不一致会出现「网页上点了标签却搜不到书」。
  if (f.tag) conds.push(hasNormalizedTag(deps, f.tag));
  if (f.license) conds.push(eq(novels.license, f.license));
  if (f.writingStatus) conds.push(eq(novels.writingStatus, f.writingStatus));
  if (f.originalsOnly) conds.push(isNull(novels.sourceNovelId));
  return conds;
}

function pageMeta(total: number, page: number, perPage: number) {
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  return { total, page: Math.min(page, pageCount), perPage, pageCount };
}

/** 公开作品的偏移分页。`page` 从 1 开始，越界时返回空列表（不 404，便于爬虫收敛）。 */
export function browseNovelsPage(deps: AppDeps, f: WebBrowseFilter, page: number, perPage: number): OffsetPage<NovelSummary> {
  const conds = filterConds(deps, f);
  const total = deps.db.select({ c: count() }).from(novels).where(and(...conds)).get()?.c ?? 0;
  const col = sortColumn(f.sort);
  const rows = deps.db
    .select({ n: novels, author: { id: users.id, displayName: users.displayName, handle: users.handle } })
    .from(novels)
    .innerJoin(users, eq(users.id, novels.authorId))
    .where(and(...conds))
    .orderBy(desc(col), desc(novels.id))
    .limit(perPage)
    .offset((page - 1) * perPage)
    .all();
  return { items: rows.map((r) => toNovelSummary(r.n, r.author)), ...pageMeta(total, page, perPage) };
}

/** 作者主页的作品分页，可按原创 / 二创筛选。 */
export function authorNovelsPage(
  deps: AppDeps,
  authorId: string,
  kind: 'all' | 'original' | 'derivative',
  page: number,
  perPage: number,
): OffsetPage<NovelSummary> {
  const conds: SQL[] = [publicListWhere(), eq(novels.authorId, authorId)];
  if (kind === 'original') conds.push(sql`${novels.sourceNovelId} IS NULL`);
  if (kind === 'derivative') conds.push(sql`${novels.sourceNovelId} IS NOT NULL`);
  const total = deps.db.select({ c: count() }).from(novels).where(and(...conds)).get()?.c ?? 0;
  const rows = deps.db
    .select({ n: novels, author: { id: users.id, displayName: users.displayName, handle: users.handle } })
    .from(novels)
    .innerJoin(users, eq(users.id, novels.authorId))
    .where(and(...conds))
    .orderBy(desc(novels.lastPublishedAt), desc(novels.id))
    .limit(perPage)
    .offset((page - 1) * perPage)
    .all();
  return { items: rows.map((r) => toNovelSummary(r.n, r.author)), ...pageMeta(total, page, perPage) };
}

/** 与浏览接口共用同一份标签目录：slug 用于链接，label 用于显示。 */
export type TagCount = TagSummary;

/** 热门标签：读维护好的 `tags.novelCount`，与浏览接口、标签目录三处同源。 */
export function popularTags(deps: AppDeps, limit: number): TagCount[] {
  return popularTagsFromDirectory(deps, limit);
}

// ---- 站点地图与 RSS 用的轻量查询 ----

export interface SitemapNovel {
  id: string;
  chapterCount: number;
  lastPublishedAt: Date | null;
}

export function publicNovelCount(deps: AppDeps): number {
  return deps.db.select({ c: count() }).from(novels).where(publicListWhere()).get()?.c ?? 0;
}

export function publicChapterTotal(deps: AppDeps): number {
  // 注意：drizzle 的 db.get() 对裸 SQL 返回的是「值数组」，只有 db.all() 才给对象，所以这里统一用 all。
  const row = deps.db.all<{ c: number | null }>(
    sql`SELECT SUM(${novels.chapterCount}) AS c FROM ${novels} WHERE ${publicListWhere()}`,
  )[0];
  return Number(row?.c ?? 0);
}

/** 站点地图分片用：按更新时间倒序取一页作品。 */
export function sitemapNovels(deps: AppDeps, offset: number, limit: number): SitemapNovel[] {
  return deps.db
    .select({ id: novels.id, chapterCount: novels.chapterCount, lastPublishedAt: novels.lastPublishedAt })
    .from(novels)
    .where(publicListWhere())
    .orderBy(desc(novels.lastPublishedAt), desc(novels.id))
    .limit(limit)
    .offset(offset)
    .all();
}

/**
 * 章节站点地图分片：给定全局章节区间 [from, to)，找出覆盖该区间的作品与各自的章节起止。
 * 用窗口函数算累计章节数，避免把所有作品拉进内存再累加。
 */
export function chapterSitemapSlice(deps: AppDeps, from: number, to: number): { id: string; start: number; end: number; lastPublishedAt: Date | null }[] {
  const rows = deps.db.all<{ id: string; chapter_count: number; cum: number; last_published_at: number | null }>(sql`
    SELECT id, chapter_count, last_published_at, cum FROM (
      SELECT ${novels.id} AS id, ${novels.chapterCount} AS chapter_count, ${novels.lastPublishedAt} AS last_published_at,
             SUM(${novels.chapterCount}) OVER (ORDER BY ${novels.lastPublishedAt} DESC, ${novels.id} DESC) AS cum
      FROM ${novels} WHERE ${publicListWhere()}
    ) WHERE cum > ${from} AND cum - chapter_count < ${to}
    ORDER BY cum ASC
  `);
  return rows.map((r) => {
    const base = Number(r.cum) - Number(r.chapter_count);
    return {
      id: String(r.id),
      start: Math.max(0, from - base),
      end: Math.min(Number(r.chapter_count), to - base),
      lastPublishedAt: r.last_published_at === null ? null : new Date(Number(r.last_published_at)),
    };
  });
}

export interface SitemapAuthor {
  handle: string;
  updatedAt: Date | null;
}

export function publicAuthorCount(deps: AppDeps): number {
  const row = deps.db.all<{ c: number }>(
    sql`SELECT COUNT(DISTINCT ${novels.authorId}) AS c FROM ${novels} WHERE ${publicListWhere()}`,
  )[0];
  return Number(row?.c ?? 0);
}

export function sitemapAuthors(deps: AppDeps, offset: number, limit: number): SitemapAuthor[] {
  const rows = deps.db.all<{ handle: string; updated_at: number | null }>(sql`
    SELECT ${users.handle} AS handle, MAX(${novels.lastPublishedAt}) AS updated_at
    FROM ${novels} INNER JOIN ${users} ON ${users.id} = ${novels.authorId}
    WHERE ${publicListWhere()}
    GROUP BY ${users.handle}
    ORDER BY updated_at DESC, handle ASC
    LIMIT ${limit} OFFSET ${offset}
  `);
  return rows.map((r) => ({ handle: String(r.handle), updatedAt: r.updated_at === null ? null : new Date(Number(r.updated_at)) }));
}

/** 全站连载更新源：按最近更新时间取作品。 */
export function recentlyUpdated(deps: AppDeps, limit: number): NovelSummary[] {
  const rows = deps.db
    .select({ n: novels, author: { id: users.id, displayName: users.displayName, handle: users.handle } })
    .from(novels)
    .innerJoin(users, eq(users.id, novels.authorId))
    .where(publicListWhere())
    .orderBy(desc(novels.lastPublishedAt), desc(novels.id))
    .limit(limit)
    .all();
  return rows.map((r) => toNovelSummary(r.n, r.author));
}

/** 标签目录页用：按标签名排序的全量标签（作品数不为 0）。 */
export function allTags(deps: AppDeps, limit: number): TagCount[] {
  return listTags(deps, { sort: 'name', limit: Math.min(limit, 50) }).items;
}
