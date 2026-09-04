/**
 * 「想读」书架与云端阅读进度（§3.4）。
 *
 * 与 `GET /me/likes` 的分工：喜欢是对作者的表态（计分、上榜），想读是自己的书架（不计分）。
 * 两张表分开，互不影响。
 *
 * 分页一律先在 SQL 里过滤掉不可见的作品再切页 —— `listMyLikes` 那种「先切页后过滤」
 * 会让页面变短却仍返回 nextCursor，客户端看起来像丢了条目（§4.6）。
 */
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type {
  BookmarkResponse,
  NovelSummary,
  Page,
  ReadingProgress,
  ReadingProgressEntry,
  UpdateReadingProgressRequest,
} from '@the-water/shared';
import type { AppDeps, AuthUser } from '../../context';
import { changes } from '../../db/client';
import { bookmarks, novels, readingProgress, users, type ReadingProgressRow } from '../../db/schema';
import { decodeCursor, encodeCursor } from '../../lib/cursor';
import { iso } from '../../lib/time';
import { assertNotBlocked } from '../users/blocking';
import { toNovelSummary } from './dto';
import { loadViewableNovel } from './service';

/** 列表里只保留仍然公开可读的作品（下架 / 审核隐藏 / 已删除的直接不出现）。 */
function stillReadable() {
  return and(eq(novels.moderationStatus, 'ok'), isNull(novels.deletedAt), sql`${novels.visibility} <> 'unpublished'`)!;
}

// ---- 想读书架 ----

export function addBookmark(deps: AppDeps, user: AuthUser, novelId: string): BookmarkResponse {
  const novel = loadViewableNovel(deps, novelId, user);
  assertNotBlocked(deps, user.id, novel.authorId);
  deps.db
    .insert(bookmarks)
    .values({ userId: user.id, novelId, createdAt: deps.clock.now() })
    .onConflictDoNothing()
    .run();
  return { bookmarked: true };
}

export function removeBookmark(deps: AppDeps, user: AuthUser, novelId: string): BookmarkResponse {
  const res = deps.db
    .delete(bookmarks)
    .where(and(eq(bookmarks.userId, user.id), eq(bookmarks.novelId, novelId)))
    .run();
  // 作品已被删除时也允许把书架条目摘掉，所以这里不校验小说是否可见。
  void changes(res);
  return { bookmarked: false };
}

export function isBookmarked(deps: AppDeps, userId: string, novelId: string): boolean {
  return !!deps.db
    .select({ x: sql`1` })
    .from(bookmarks)
    .where(and(eq(bookmarks.userId, userId), eq(bookmarks.novelId, novelId)))
    .get();
}

export function listMyBookmarks(
  deps: AppDeps,
  user: AuthUser,
  cursorRaw: string | undefined,
  limit: number,
): Page<NovelSummary> {
  const cursor = decodeCursor(cursorRaw);
  const conds = [eq(bookmarks.userId, user.id), stillReadable()];
  if (cursor) {
    conds.push(
      or(
        lt(bookmarks.createdAt, new Date(cursor.v)),
        and(eq(bookmarks.createdAt, new Date(cursor.v)), lt(bookmarks.novelId, cursor.id)),
      )!,
    );
  }
  const rows = deps.db
    .select({
      addedAt: bookmarks.createdAt,
      n: novels,
      author: { id: users.id, displayName: users.displayName, handle: users.handle },
    })
    .from(bookmarks)
    .innerJoin(novels, eq(novels.id, bookmarks.novelId))
    .innerJoin(users, eq(users.id, novels.authorId))
    .where(and(...conds))
    .orderBy(desc(bookmarks.createdAt), desc(bookmarks.novelId))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => toNovelSummary(r.n, r.author)),
    nextCursor: rows.length > limit && last ? encodeCursor({ v: last.addedAt.getTime(), id: last.n.id }) : null,
  };
}

// ---- 云端阅读进度 ----

function toProgress(r: ReadingProgressRow): ReadingProgress {
  return {
    novelId: r.novelId,
    chapterIndex: r.chapterIndex,
    percent: r.percent,
    updatedAt: iso(r.updatedAt),
  };
}

export function getProgress(deps: AppDeps, user: AuthUser, novelId: string): ReadingProgress | null {
  const row = deps.db
    .select()
    .from(readingProgress)
    .where(and(eq(readingProgress.userId, user.id), eq(readingProgress.novelId, novelId)))
    .get();
  return row ? toProgress(row) : null;
}

/** 上报阅读进度。同一 (user, novel) 只有一行，后写覆盖先写。 */
export function saveProgress(
  deps: AppDeps,
  user: AuthUser,
  novelId: string,
  input: UpdateReadingProgressRequest,
): ReadingProgress {
  loadViewableNovel(deps, novelId, user);
  const now = deps.clock.now();
  deps.db
    .insert(readingProgress)
    .values({ userId: user.id, novelId, chapterIndex: input.chapterIndex, percent: input.percent, updatedAt: now })
    .onConflictDoUpdate({
      target: [readingProgress.userId, readingProgress.novelId],
      set: { chapterIndex: input.chapterIndex, percent: input.percent, updatedAt: now },
    })
    .run();
  return { novelId, chapterIndex: input.chapterIndex, percent: input.percent, updatedAt: iso(now) };
}

/** 在读的书，按最近阅读时间倒序。 */
export function listMyProgress(
  deps: AppDeps,
  user: AuthUser,
  cursorRaw: string | undefined,
  limit: number,
): Page<ReadingProgressEntry> {
  const cursor = decodeCursor(cursorRaw);
  const conds = [eq(readingProgress.userId, user.id), stillReadable()];
  if (cursor) {
    conds.push(
      or(
        lt(readingProgress.updatedAt, new Date(cursor.v)),
        and(eq(readingProgress.updatedAt, new Date(cursor.v)), lt(readingProgress.novelId, cursor.id)),
      )!,
    );
  }
  const rows = deps.db
    .select({
      p: readingProgress,
      n: novels,
      author: { id: users.id, displayName: users.displayName, handle: users.handle },
    })
    .from(readingProgress)
    .innerJoin(novels, eq(novels.id, readingProgress.novelId))
    .innerJoin(users, eq(users.id, novels.authorId))
    .where(and(...conds))
    .orderBy(desc(readingProgress.updatedAt), desc(readingProgress.novelId))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({ novel: toNovelSummary(r.n, r.author), progress: toProgress(r.p) })),
    nextCursor: rows.length > limit && last ? encodeCursor({ v: last.p.updatedAt.getTime(), id: last.n.id }) : null,
  };
}
