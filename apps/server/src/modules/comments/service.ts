/**
 * 两级留言：parentId 恒指向顶层，replyToId 指向被回复的那一条。
 * 删除是软删除；顶层若已有回复则保留一块墓碑，回复才不会失去上下文。
 */
import { and, asc, desc, eq, gt, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { Comment, CreateCommentRequest, Page } from '@the-water/shared';
import type { AppDeps, AuthUser } from '../../context';
import { changes } from '../../db/client';
import { comments, novels, reports, users, type CommentRow } from '../../db/schema';
import { decodeCursor, encodeCursor } from '../../lib/cursor';
import { forbidden, notFound } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { iso } from '../../lib/time';
import { toAuthorCard, type AuthorParts } from '../novels/dto';
import { isPubliclyViewable, loadViewableNovel, type Viewer } from '../novels/service';
import { assertNotBlocked, notBlockedEitherWay } from '../users/blocking';

type Executor = Pick<AppDeps['db'], 'select' | 'insert' | 'update' | 'delete'>;

export interface CommentHooks {
  /** 留言写入后回调（记积分）。 */
  onCommented?: (tx: Executor, ctx: { commentId: string; authorId: string; novelId: string; novelAuthorId: string }) => void;
}

function canDelete(c: CommentRow, novelAuthorId: string, viewer: Viewer): boolean {
  if (!viewer) return false;
  return viewer.id === c.authorId || viewer.id === novelAuthorId || viewer.role === 'admin';
}

export function toComment(
  c: CommentRow,
  author: AuthorParts,
  novelAuthorId: string,
  viewer: Viewer,
  replyToName: string | null,
): Comment {
  const gone = c.status !== 'ok';
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
    createdAt: iso(c.createdAt),
    viewer: viewer ? { canDelete: !gone && canDelete(c, novelAuthorId, viewer) } : null,
  };
}

function findComment(deps: AppDeps, novelId: string, id: string): CommentRow | undefined {
  return deps.db.select().from(comments).where(and(eq(comments.id, id), eq(comments.novelId, novelId))).get();
}

function displayNameOf(deps: AppDeps, userId: string): string | null {
  return deps.db.select({ n: users.displayName }).from(users).where(eq(users.id, userId)).get()?.n ?? null;
}

export function createComment(
  deps: AppDeps,
  user: AuthUser,
  novelId: string,
  req: CreateCommentRequest,
  hooks: CommentHooks = {},
): Comment {
  const novel = loadViewableNovel(deps, novelId, user);
  if (!isPubliclyViewable(novel)) throw notFound('小说');
  assertNotBlocked(deps, user.id, novel.authorId);

  let parentId: string | null = null;
  let replyToId: string | null = null;
  let replyToName: string | null = null;
  if (req.replyToId) {
    const target = findComment(deps, novelId, req.replyToId);
    // 对我不可见的留言（已删除、被隐藏、互相屏蔽）等同于不存在。
    if (!target || target.status !== 'ok') throw notFound('留言');
    if (target.authorId !== user.id) assertNotBlocked(deps, user.id, target.authorId);
    parentId = target.parentId ?? target.id;
    replyToId = target.id;
    replyToName = displayNameOf(deps, target.authorId);
  }

  const row: typeof comments.$inferInsert = {
    id: newId(),
    novelId,
    authorId: user.id,
    parentId,
    replyToId,
    body: req.body,
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
  });

  const author: AuthorParts = { id: user.id, displayName: user.displayName, handle: user.handle };
  return toComment(findComment(deps, novelId, row.id!)!, author, novel.authorId, user, replyToName);
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

/** 顶层留言：倒序；已删除但仍有回复的留一块墓碑。 */
export function listComments(deps: AppDeps, novelId: string, viewer: Viewer, cursorRaw: string | undefined, limit: number): Page<Comment> {
  const novel = loadViewableNovel(deps, novelId, viewer);
  const conds: SQL[] = [
    eq(comments.novelId, novelId),
    isNull(comments.parentId),
    or(eq(comments.status, 'ok'), gt(comments.replyCount, 0))!,
  ];
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
  return {
    items: page.map((r) => toComment(r.c, r.author, novel.authorId, viewer, r.c.replyToId ? names.get(r.c.replyToId) ?? null : null)),
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
  return {
    items: page.map((r) => toComment(r.c, r.author, novel.authorId, viewer, r.c.replyToId ? names.get(r.c.replyToId) ?? null : null)),
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
  return toComment(fresh, author, novel.authorId, admin, null);
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

/** 举报一条留言：复用 reports 表，commentId 非空即为评论举报。 */
export function reportComment(
  deps: AppDeps,
  novelId: string,
  commentId: string,
  viewer: Viewer,
  req: { reason: 'plagiarism' | 'illegal' | 'adult' | 'spam' | 'other'; detail?: string },
) {
  loadViewableNovel(deps, novelId, viewer);
  const c = findComment(deps, novelId, commentId);
  if (!c || c.status !== 'ok') throw notFound('留言');
  const row: typeof reports.$inferInsert = {
    id: newId(),
    novelId,
    commentId,
    reporterId: viewer?.id ?? null,
    reason: req.reason,
    detail: req.detail ?? null,
    status: 'open',
    createdAt: deps.clock.now(),
  };
  deps.db.insert(reports).values(row).run();
  return deps.db.select().from(reports).where(eq(reports.id, row.id!)).get()!;
}
