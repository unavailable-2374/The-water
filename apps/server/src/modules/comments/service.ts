/**
 * 两级留言：parentId 恒指向顶层，replyToId 指向被回复的那一条。
 * 删除是软删除；顶层若已有回复则保留一块墓碑，回复才不会失去上下文。
 */
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  COMMENT_EDIT_WINDOW_MS,
  type Comment,
  type CommentListQuery,
  type CreateCommentRequest,
  type Page,
  type UpdateCommentRequest,
} from '@the-water/shared';
import type { AppDeps, AuthUser } from '../../context';
import { changes } from '../../db/client';
import { commentLikes, comments, novels, reports, users, type CommentRow } from '../../db/schema';
import { assertTextAllowed } from '../admin/audit';
import { decodeCursor, encodeCursor } from '../../lib/cursor';
import { forbidden, notFound, validation } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { iso, isoOrNull } from '../../lib/time';
import { notifyCommentLike, notifyMentionsOnEdit, notifyOnComment } from '../notifications/service';
import { toAuthorCard, type AuthorParts } from '../novels/dto';
import { isPubliclyViewable, loadViewableNovel, type Viewer } from '../novels/service';
import { assertNotBlocked, notBlockedEitherWay } from '../users/blocking';
import { insertReport } from '../social/service';

type Executor = Pick<AppDeps['db'], 'select' | 'insert' | 'update' | 'delete'>;

export interface CommentHooks {
  /** 留言写入后回调（记积分）。 */
  onCommented?: (tx: Executor, ctx: { commentId: string; authorId: string; novelId: string; novelAuthorId: string }) => void;
}

/** 留言可编辑的窗口内（默认 15 分钟）。超时只能删，不能改。 */
export function withinEditWindow(now: Date, createdAt: Date): boolean {
  return now.getTime() - createdAt.getTime() <= COMMENT_EDIT_WINDOW_MS;
}

function canDelete(c: CommentRow, novelAuthorId: string, viewer: Viewer): boolean {
  if (!viewer) return false;
  return viewer.id === c.authorId || viewer.id === novelAuthorId || viewer.role === 'admin';
}

export interface CommentViewOpts {
  /** 当前访客是否赞过这条留言。 */
  liked?: boolean;
  /** 判断编辑窗口用的「现在」。不传则一律不可编辑。 */
  now?: Date;
}

export function toComment(
  c: CommentRow,
  author: AuthorParts,
  novelAuthorId: string,
  viewer: Viewer,
  replyToName: string | null,
  opts: CommentViewOpts = {},
): Comment {
  const gone = c.status !== 'ok';
  const canEdit = !gone && !!viewer && viewer.id === c.authorId && !!opts.now && withinEditWindow(opts.now, c.createdAt);
  return {
    id: c.id,
    novelId: c.novelId,
    parentId: c.parentId,
    replyToId: c.replyToId,
    replyToName: gone ? null : replyToName,
    author: toAuthorCard(author),
    body: gone ? '' : c.body,
    status: c.status,
    replyCount: c.replyCount,
    chapterIndex: c.chapterIndex,
    likeCount: c.likeCount,
    editedAt: gone ? null : isoOrNull(c.editedAt),
    createdAt: iso(c.createdAt),
    viewer: viewer ? { canDelete: !gone && canDelete(c, novelAuthorId, viewer), canEdit, liked: opts.liked ?? false } : null,
  };
}

/** 一次查出访客赞过哪些留言，避免逐条回查。 */
function likedSet(deps: AppDeps, viewer: Viewer, ids: string[]): Set<string> {
  if (!viewer || !ids.length) return new Set();
  const rows = deps.db
    .select({ id: commentLikes.commentId })
    .from(commentLikes)
    .where(and(eq(commentLikes.userId, viewer.id), inArray(commentLikes.commentId, ids)))
    .all();
  return new Set(rows.map((r) => r.id));
}

function findComment(deps: AppDeps, novelId: string, id: string): CommentRow | undefined {
  return deps.db.select().from(comments).where(and(eq(comments.id, id), eq(comments.novelId, novelId))).get();
}

function displayNameOf(deps: AppDeps, userId: string): string | null {
  return deps.db.select({ n: users.displayName }).from(users).where(eq(users.id, userId)).get()?.n ?? null;
}

export async function createComment(
  deps: AppDeps,
  user: AuthUser,
  novelId: string,
  req: CreateCommentRequest,
  hooks: CommentHooks = {},
): Promise<Comment> {
  const novel = loadViewableNovel(deps, novelId, user);
  if (!isPubliclyViewable(novel)) throw notFound('小说');
  assertNotBlocked(deps, user.id, novel.authorId);
  // P0-2：留言与正文走同一条审核通道，命中即拒绝。
  await assertTextAllowed(deps, [{ label: '留言', text: req.body }], {
    type: 'novel',
    id: novelId,
    meta: { kind: 'comment', authorId: user.id },
  });

  let parentId: string | null = null;
  let replyToId: string | null = null;
  let replyToName: string | null = null;
  let replyToAuthorId: string | null = null;
  // 章节级留言（§3.6）。回复恒随被回复的那条走，一个线程不会横跨两章。
  let chapterIndex = normalizeChapterIndex(novel.chapterCount, req.chapterIndex);
  if (req.replyToId) {
    const target = findComment(deps, novelId, req.replyToId);
    // 对我不可见的留言（已删除、被隐藏、互相屏蔽）等同于不存在。
    if (!target || target.status !== 'ok') throw notFound('留言');
    if (target.authorId !== user.id) assertNotBlocked(deps, user.id, target.authorId);
    parentId = target.parentId ?? target.id;
    replyToId = target.id;
    replyToName = displayNameOf(deps, target.authorId);
    replyToAuthorId = target.authorId;
    chapterIndex = target.chapterIndex;
  }

  const row: typeof comments.$inferInsert = {
    id: newId(),
    novelId,
    authorId: user.id,
    parentId,
    replyToId,
    chapterIndex,
    body: req.body,
    likeCount: 0,
    editedAt: null,
    status: 'ok',
    replyCount: 0,
    createdAt: deps.clock.now(),
    deletedAt: null,
  };
  deps.db.transaction((tx) => {
    tx.insert(comments).values(row).run();
    tx.update(novels).set({ commentCount: sql`${novels.commentCount} + 1` }).where(eq(novels.id, novelId)).run();
    if (parentId) {
      tx.update(comments).set({ replyCount: sql`${comments.replyCount} + 1` }).where(eq(comments.id, parentId)).run();
    }
    hooks.onCommented?.(tx, { commentId: row.id!, authorId: user.id, novelId, novelAuthorId: novel.authorId });
    // §3.1：回复 / @提及 / 作品被留言三类通知在同一个事务里发出。
    notifyOnComment(deps, tx, {
      commentId: row.id!,
      body: req.body,
      authorId: user.id,
      novelId,
      novelTitle: novel.title,
      novelAuthorId: novel.authorId,
      chapterIndex,
      replyToId,
      replyToAuthorId,
    });
  });

  const author: AuthorParts = { id: user.id, displayName: user.displayName, handle: user.handle };
  return toComment(findComment(deps, novelId, row.id!)!, author, novel.authorId, user, replyToName, { now: deps.clock.now() });
}

/** 章节下标校验：必须落在这本书已发布的章节范围内。 */
function normalizeChapterIndex(chapterCount: number, raw: number | undefined): number | null {
  if (raw === undefined) return null;
  if (raw < 0 || raw >= Math.max(chapterCount, 0)) throw validation('这一章不存在');
  return raw;
}

/**
 * 编辑自己的留言（§3.6）：只在 15 分钟窗口内，且只改正文。
 * 正文重新过一遍审核；编辑后新出现的 @提及会补发通知（老的被 dedupeKey 挡住）。
 */
export async function updateComment(
  deps: AppDeps,
  user: AuthUser,
  novelId: string,
  commentId: string,
  req: UpdateCommentRequest,
): Promise<Comment> {
  const novel = loadViewableNovel(deps, novelId, user);
  const c = findComment(deps, novelId, commentId);
  if (!c || c.status !== 'ok') throw notFound('留言');
  if (c.authorId !== user.id) throw forbidden('只能编辑自己的留言');
  const now = deps.clock.now();
  if (!withinEditWindow(now, c.createdAt)) throw forbidden('超过 15 分钟的留言不能再编辑了');
  await assertTextAllowed(deps, [{ label: '留言', text: req.body }], {
    type: 'novel',
    id: novelId,
    meta: { kind: 'comment', authorId: user.id, commentId },
  });

  deps.db.transaction((tx) => {
    tx.update(comments).set({ body: req.body, editedAt: now }).where(eq(comments.id, commentId)).run();
    notifyMentionsOnEdit(deps, tx, {
      commentId,
      body: req.body,
      authorId: user.id,
      novelTitle: novel.title,
      chapterIndex: c.chapterIndex,
    });
  });

  const fresh = findComment(deps, novelId, commentId)!;
  const author: AuthorParts = { id: user.id, displayName: user.displayName, handle: user.handle };
  const liked = likedSet(deps, user, [commentId]).has(commentId);
  const names = replyToNames(deps, [fresh]);
  return toComment(fresh, author, novel.authorId, user, fresh.replyToId ? names.get(fresh.replyToId) ?? null : null, { liked, now });
}

/** 给留言点赞 / 取消点赞（§3.6）。likeCount 与 comment_likes 在同一事务里维护。 */
export function likeComment(
  deps: AppDeps,
  user: AuthUser,
  novelId: string,
  commentId: string,
  liked: boolean,
): { liked: boolean; likeCount: number } {
  loadViewableNovel(deps, novelId, user);
  const c = findComment(deps, novelId, commentId);
  if (!c || c.status !== 'ok') throw notFound('留言');
  if (c.authorId !== user.id) assertNotBlocked(deps, user.id, c.authorId);
  deps.db.transaction((tx) => {
    if (liked) {
      const res = tx
        .insert(commentLikes)
        .values({ userId: user.id, commentId, createdAt: deps.clock.now() })
        .onConflictDoNothing()
        .run();
      if (changes(res) > 0) {
        tx.update(comments).set({ likeCount: sql`${comments.likeCount} + 1` }).where(eq(comments.id, commentId)).run();
        notifyCommentLike(deps, tx, c, user.id);
      }
    } else {
      const res = tx.delete(commentLikes).where(and(eq(commentLikes.userId, user.id), eq(commentLikes.commentId, commentId))).run();
      if (changes(res) > 0) {
        tx.update(comments).set({ likeCount: sql`max(${comments.likeCount} - 1, 0)` }).where(eq(comments.id, commentId)).run();
      }
    }
  });
  return { liked, likeCount: findComment(deps, novelId, commentId)?.likeCount ?? 0 };
}

function replyToNames(deps: AppDeps, rows: CommentRow[]): Map<string, string> {
  const ids = rows.map((r) => r.replyToId).filter((x): x is string => !!x);
  if (!ids.length) return new Map();
  const out = new Map<string, string>();
  for (const id of new Set(ids)) {
    const target = deps.db.select({ authorId: comments.authorId }).from(comments).where(eq(comments.id, id)).get();
    const name = target ? displayNameOf(deps, target.authorId) : null;
    if (name) out.set(id, name);
  }
  return out;
}

/**
 * 顶层留言：倒序；已删除但仍有回复的留一块墓碑。
 * `chapter` 为数字时只看该章，为 'novel' 时只看作品级，缺省时两者都给。
 */
export function listComments(deps: AppDeps, novelId: string, viewer: Viewer, q: CommentListQuery): Page<Comment> {
  const { cursor: cursorRaw, limit } = q;
  const novel = loadViewableNovel(deps, novelId, viewer);
  const conds: SQL[] = [
    eq(comments.novelId, novelId),
    isNull(comments.parentId),
    or(eq(comments.status, 'ok'), gt(comments.replyCount, 0))!,
  ];
  if (q.chapter === 'novel') conds.push(isNull(comments.chapterIndex));
  else if (typeof q.chapter === 'number') conds.push(eq(comments.chapterIndex, q.chapter));
  if (viewer) conds.push(notBlockedEitherWay(deps, viewer.id, comments.authorId));
  const cursor = decodeCursor(cursorRaw);
  if (cursor) {
    conds.push(
      or(lt(comments.createdAt, new Date(cursor.v)), and(eq(comments.createdAt, new Date(cursor.v)), lt(comments.id, cursor.id)))!,
    );
  }
  const rows = deps.db
    .select({ c: comments, author: { id: users.id, displayName: users.displayName, handle: users.handle } })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.authorId))
    .where(and(...conds))
    .orderBy(desc(comments.createdAt), desc(comments.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const names = replyToNames(deps, page.map((r) => r.c));
  const liked = likedSet(deps, viewer, page.map((r) => r.c.id));
  const now = deps.clock.now();
  return {
    items: page.map((r) =>
      toComment(r.c, r.author, novel.authorId, viewer, r.c.replyToId ? names.get(r.c.replyToId) ?? null : null, {
        liked: liked.has(r.c.id),
        now,
      }),
    ),
    nextCursor: rows.length > limit && last ? encodeCursor({ v: last.c.createdAt.getTime(), id: last.c.id }) : null,
  };
}

/** 某条顶层留言下的回复：正序，读起来像对话。 */
export function listReplies(
  deps: AppDeps,
  novelId: string,
  parentId: string,
  viewer: Viewer,
  cursorRaw: string | undefined,
  limit: number,
): Page<Comment> {
  const novel = loadViewableNovel(deps, novelId, viewer);
  const parent = findComment(deps, novelId, parentId);
  if (!parent) throw notFound('留言');
  const conds: SQL[] = [eq(comments.parentId, parentId), eq(comments.status, 'ok')];
  if (viewer) conds.push(notBlockedEitherWay(deps, viewer.id, comments.authorId));
  const cursor = decodeCursor(cursorRaw);
  if (cursor) {
    conds.push(
      or(gt(comments.createdAt, new Date(cursor.v)), and(eq(comments.createdAt, new Date(cursor.v)), gt(comments.id, cursor.id)))!,
    );
  }
  const rows = deps.db
    .select({ c: comments, author: { id: users.id, displayName: users.displayName, handle: users.handle } })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.authorId))
    .where(and(...conds))
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const names = replyToNames(deps, page.map((r) => r.c));
  const liked = likedSet(deps, viewer, page.map((r) => r.c.id));
  const now = deps.clock.now();
  return {
    items: page.map((r) =>
      toComment(r.c, r.author, novel.authorId, viewer, r.c.replyToId ? names.get(r.c.replyToId) ?? null : null, {
        liked: liked.has(r.c.id),
        now,
      }),
    ),
    nextCursor: rows.length > limit && last ? encodeCursor({ v: last.c.createdAt.getTime(), id: last.c.id }) : null,
  };
}

export function deleteComment(deps: AppDeps, user: AuthUser, novelId: string, commentId: string): void {
  const novel = loadViewableNovel(deps, novelId, user);
  const c = findComment(deps, novelId, commentId);
  if (!c || c.status === 'deleted') throw notFound('留言');
  if (!canDelete(c, novel.authorId, user)) throw forbidden('只有留言的人、作者或管理员可以删除');
  applyRemoval(deps, c, 'deleted');
}

/** 管理员隐藏/恢复一条留言。隐藏的渲染方式与删除相同。 */
export function setCommentStatus(deps: AppDeps, admin: AuthUser, novelId: string, commentId: string, status: 'ok' | 'hidden'): Comment {
  const c = findComment(deps, novelId, commentId);
  if (!c) throw notFound('留言');
  const novel = deps.db.select().from(novels).where(eq(novels.id, novelId)).get()!;
  if (status === 'hidden' && c.status === 'ok') applyRemoval(deps, c, 'hidden');
  if (status === 'ok' && c.status === 'hidden') restore(deps, c);
  const fresh = findComment(deps, novelId, commentId)!;
  const author = deps.db
    .select({ id: users.id, displayName: users.displayName, handle: users.handle })
    .from(users)
    .where(eq(users.id, fresh.authorId))
    .get()!;
  return toComment(fresh, author, novel.authorId, admin, null, { now: deps.clock.now() });
}

function applyRemoval(deps: AppDeps, c: CommentRow, status: 'deleted' | 'hidden'): void {
  const now = deps.clock.now();
  deps.db.transaction((tx) => {
    const res = tx
      .update(comments)
      .set({ status, deletedAt: now })
      .where(and(eq(comments.id, c.id), eq(comments.status, 'ok')))
      .run();
    if (changes(res) === 0) return;
    tx.update(novels).set({ commentCount: sql`max(${novels.commentCount} - 1, 0)` }).where(eq(novels.id, c.novelId)).run();
    if (c.parentId) {
      tx.update(comments).set({ replyCount: sql`max(${comments.replyCount} - 1, 0)` }).where(eq(comments.id, c.parentId)).run();
    }
  });
}

function restore(deps: AppDeps, c: CommentRow): void {
  deps.db.transaction((tx) => {
    const res = tx
      .update(comments)
      .set({ status: 'ok', deletedAt: null })
      .where(and(eq(comments.id, c.id), eq(comments.status, 'hidden')))
      .run();
    if (changes(res) === 0) return;
    tx.update(novels).set({ commentCount: sql`${novels.commentCount} + 1` }).where(eq(novels.id, c.novelId)).run();
    if (c.parentId) {
      tx.update(comments).set({ replyCount: sql`${comments.replyCount} + 1` }).where(eq(comments.id, c.parentId)).run();
    }
  });
}

/**
 * 举报一条留言：复用 reports 表，commentId 非空即为评论举报。
 * 要求登录并按 `${novelId}:${commentId}:${reporterId}` 去重（§3.3）。
 */
export function reportComment(
  deps: AppDeps,
  novelId: string,
  commentId: string,
  user: AuthUser,
  viewerKey: string,
  req: { reason: 'plagiarism' | 'illegal' | 'adult' | 'spam' | 'other'; detail?: string },
) {
  loadViewableNovel(deps, novelId, user);
  const c = findComment(deps, novelId, commentId);
  if (!c || c.status !== 'ok') throw notFound('留言');
  return insertReport(deps, {
    novelId,
    commentId,
    reporterId: user.id,
    viewerKey,
    reason: req.reason,
    detail: req.detail ?? null,
  });
}
