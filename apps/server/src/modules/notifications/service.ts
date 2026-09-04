/**
 * 站内通知（§3.1）。事件源是现成的：积分引擎的各个 award* 入口、留言写入、审核动作，
 * 这里只提供「出口」——写一行 notifications，并把渲染要用的文案冗余进 title / body，
 * 好让通知列表一次查询就能渲染完（不再回查作品、留言、用户）。
 *
 * 两条铁律：
 * 1. 不给自己发通知（自赞、自评、自己 fork 自己的书都不发）；
 * 2. 同一件事只通知一次，靠 dedupeKey 的唯一索引兜底，业务侧可以放心重复调用。
 */
import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  BADGE_BY_ID,
  type BadgeId,
  type MarkNotificationsReadRequest,
  type Notification,
  type NotificationKind,
  type NotificationListResponse,
  type NotificationQuery,
  parseMentions,
} from '@the-water/shared';
import type { AppDeps, AuthUser } from '../../context';
import { changes } from '../../db/client';
import { comments, notifications, novels, users, type CommentRow, type NotificationRow, type NovelRow } from '../../db/schema';
import { decodeCursor, encodeCursor } from '../../lib/cursor';
import { iso, isoOrNull } from '../../lib/time';
import { newId } from '../../lib/ids';

/** 与积分引擎一样：既能独立执行，也能挂在调用方事务里。 */
export type Executor = Pick<AppDeps['db'], 'select' | 'insert' | 'update' | 'delete'>;

export type NotificationRefType = 'novel' | 'user' | 'comment' | 'badge' | 'system';

export interface NotifyInput {
  /** 收件人。 */
  userId: string;
  /** 触发者；与收件人相同则整条跳过。系统通知传 null。 */
  actorId: string | null;
  kind: NotificationKind;
  refType: NotificationRefType;
  refId: string;
  title: string;
  body?: string;
  dedupeKey: string;
}

/** 写一条通知。返回是否真的写进去了（自触发、dedupeKey 命中都会返回 false）。 */
export function notify(deps: AppDeps, ex: Executor, input: NotifyInput): boolean {
  if (input.actorId && input.actorId === input.userId) return false;
  const res = ex
    .insert(notifications)
    .values({
      id: newId(),
      userId: input.userId,
      actorId: input.actorId,
      kind: input.kind,
      refType: input.refType,
      refId: input.refId,
      title: input.title,
      body: input.body ?? '',
      readAt: null,
      dedupeKey: input.dedupeKey,
      createdAt: deps.clock.now(),
    })
    .onConflictDoNothing()
    .run();
  return changes(res) > 0;
}

// ---- 文案 ----

const EXCERPT_MAX = 80;

/** 留言摘要：过长截断，换行压成空格，避免通知列表里撑出一大坨。 */
export function excerpt(text: string, max = EXCERPT_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function nameOf(ex: Executor, userId: string): string {
  return ex.select({ n: users.displayName }).from(users).where(eq(users.id, userId)).get()?.n ?? '有人';
}

function chapterLabel(chapterIndex: number | null | undefined): string {
  return chapterIndex === null || chapterIndex === undefined ? '' : `第 ${chapterIndex + 1} 章`;
}

// ---- 各处的通知入口 ----

/** 被关注。refId 是关注者，点开落到对方主页。 */
export function notifyFollow(deps: AppDeps, ex: Executor, followeeId: string, followerId: string): void {
  notify(deps, ex, {
    userId: followeeId,
    actorId: followerId,
    kind: 'followed',
    refType: 'user',
    refId: followerId,
    title: `${nameOf(ex, followerId)} 关注了你`,
    dedupeKey: `followed:${followeeId}:${followerId}`,
  });
}

/** 作品被喜欢。 */
export function notifyLike(deps: AppDeps, ex: Executor, novel: NovelRow, likerId: string): void {
  notify(deps, ex, {
    userId: novel.authorId,
    actorId: likerId,
    kind: 'liked',
    refType: 'novel',
    refId: novel.id,
    title: `${nameOf(ex, likerId)} 喜欢了《${novel.title}》`,
    dedupeKey: `liked:${novel.id}:${likerId}`,
  });
}

/** 作品被派生（fork）。 */
export function notifyFork(deps: AppDeps, ex: Executor, novel: NovelRow, forkerId: string): void {
  notify(deps, ex, {
    userId: novel.authorId,
    actorId: forkerId,
    kind: 'forked',
    refType: 'novel',
    refId: novel.id,
    title: `${nameOf(ex, forkerId)} 派生了《${novel.title}》`,
    dedupeKey: `forked:${novel.id}:${forkerId}`,
  });
}

export interface CommentNotifyContext {
  commentId: string;
  body: string;
  authorId: string;
  novelId: string;
  novelTitle: string;
  novelAuthorId: string;
  chapterIndex: number | null;
  /** 回复的目标留言及其作者（顶层留言为 null）。 */
  replyToId: string | null;
  replyToAuthorId: string | null;
}

/**
 * 一条留言最多产生三类通知：回复给被回复者、留言给作品作者、@提及给被点名的人。
 * 同一个人只会收到其中优先级最高的一条（回复 > 提及 > 留言），不会被同一条留言轰炸三遍。
 */
export function notifyOnComment(deps: AppDeps, ex: Executor, ctx: CommentNotifyContext): void {
  const at = chapterLabel(ctx.chapterIndex);
  const suffix = at ? `（${at}）` : '';
  const notified = new Set<string>([ctx.authorId]);

  if (ctx.replyToId && ctx.replyToAuthorId && !notified.has(ctx.replyToAuthorId)) {
    notified.add(ctx.replyToAuthorId);
    notify(deps, ex, {
      userId: ctx.replyToAuthorId,
      actorId: ctx.authorId,
      kind: 'replied',
      refType: 'comment',
      refId: ctx.commentId,
      title: `${nameOf(ex, ctx.authorId)} 回复了你在《${ctx.novelTitle}》的留言${suffix}`,
      body: excerpt(ctx.body),
      dedupeKey: `replied:${ctx.commentId}`,
    });
  }

  for (const userId of mentionTargets(ex, ctx.body, notified)) {
    notified.add(userId);
    notify(deps, ex, {
      userId,
      actorId: ctx.authorId,
      kind: 'mentioned',
      refType: 'comment',
      refId: ctx.commentId,
      title: `${nameOf(ex, ctx.authorId)} 在《${ctx.novelTitle}》的留言里提到了你${suffix}`,
      body: excerpt(ctx.body),
      dedupeKey: `mentioned:${ctx.commentId}:${userId}`,
    });
  }

  if (!notified.has(ctx.novelAuthorId)) {
    notify(deps, ex, {
      userId: ctx.novelAuthorId,
      actorId: ctx.authorId,
      kind: 'commented',
      refType: 'comment',
      refId: ctx.commentId,
      title: `${nameOf(ex, ctx.authorId)} 留言了《${ctx.novelTitle}》${suffix}`,
      body: excerpt(ctx.body),
      dedupeKey: `commented:${ctx.commentId}`,
    });
  }
}

/** 解析 @用户名 并映射成用户 id（跳过已通知过的人与不存在的用户名）。 */
function mentionTargets(ex: Executor, body: string, exclude: ReadonlySet<string>): string[] {
  const handles = parseMentions(body);
  if (!handles.length) return [];
  const rows = ex.select({ id: users.id }).from(users).where(inArray(users.handle, handles)).all();
  return rows.map((r) => r.id).filter((id) => !exclude.has(id));
}

/**
 * 编辑留言后补发 @提及：dedupeKey 带 userId，之前已通知过的人不会再收到一遍。
 */
export function notifyMentionsOnEdit(
  deps: AppDeps,
  ex: Executor,
  ctx: Pick<CommentNotifyContext, 'commentId' | 'body' | 'authorId' | 'novelTitle' | 'chapterIndex'>,
): void {
  const at = chapterLabel(ctx.chapterIndex);
  const suffix = at ? `（${at}）` : '';
  for (const userId of mentionTargets(ex, ctx.body, new Set([ctx.authorId]))) {
    notify(deps, ex, {
      userId,
      actorId: ctx.authorId,
      kind: 'mentioned',
      refType: 'comment',
      refId: ctx.commentId,
      title: `${nameOf(ex, ctx.authorId)} 在《${ctx.novelTitle}》的留言里提到了你${suffix}`,
      body: excerpt(ctx.body),
      dedupeKey: `mentioned:${ctx.commentId}:${userId}`,
    });
  }
}

/** 留言被点赞。 */
export function notifyCommentLike(deps: AppDeps, ex: Executor, comment: CommentRow, likerId: string): void {
  notify(deps, ex, {
    userId: comment.authorId,
    actorId: likerId,
    kind: 'comment_liked',
    refType: 'comment',
    refId: comment.id,
    title: `${nameOf(ex, likerId)} 赞了你的留言`,
    body: excerpt(comment.body),
    dedupeKey: `comment_liked:${comment.id}:${likerId}`,
  });
}

/** 获得徽章。系统通知，没有触发者。 */
export function notifyBadge(deps: AppDeps, ex: Executor, userId: string, badge: BadgeId): void {
  const def = BADGE_BY_ID[badge];
  if (!def) return;
  notify(deps, ex, {
    userId,
    actorId: null,
    kind: 'badge',
    refType: 'badge',
    refId: badge,
    title: `获得徽章「${def.name}」`,
    body: def.description,
    dedupeKey: `badge:${userId}:${badge}`,
  });
}

const NOVEL_MODERATION_TEXT = {
  hidden: '已被暂时隐藏，正在人工复核',
  removed: '已被下架',
  ok: '已恢复展示',
} as const;

/**
 * 作品被隐藏 / 下架 / 恢复。
 * dedupeKey 带上动作发生的时刻：同一秒里的重复处置只通知一次，
 * 而「隐藏 → 恢复 → 再隐藏」是三件事，作者应该三次都收到。
 */
export function notifyNovelModeration(
  deps: AppDeps,
  ex: Executor,
  novel: NovelRow,
  status: 'ok' | 'hidden' | 'removed',
  note: string | null,
): void {
  notify(deps, ex, {
    userId: novel.authorId,
    actorId: null,
    kind: 'moderation_novel',
    refType: 'novel',
    refId: novel.id,
    title: `《${novel.title}》${NOVEL_MODERATION_TEXT[status]}`,
    body: note ?? '',
    dedupeKey: `moderation_novel:${novel.id}:${status}:${deps.clock.now().getTime()}`,
  });
}

/** 留言被隐藏 / 恢复。 */
export function notifyCommentModeration(
  deps: AppDeps,
  ex: Executor,
  comment: CommentRow,
  novelTitle: string,
  status: 'ok' | 'hidden',
  note: string | null,
): void {
  notify(deps, ex, {
    userId: comment.authorId,
    actorId: null,
    kind: 'moderation_comment',
    refType: 'comment',
    refId: comment.id,
    title: `你在《${novelTitle}》的留言${status === 'hidden' ? '已被隐藏' : '已恢复展示'}`,
    body: note ?? excerpt(comment.body),
    dedupeKey: `moderation_comment:${comment.id}:${status}:${deps.clock.now().getTime()}`,
  });
}

// ---- 读取 ----

type ActorParts = { id: string; handle: string; displayName: string } | null;

function toNotification(r: NotificationRow, actor: ActorParts, novelId: string | null): Notification {
  return {
    id: r.id,
    kind: r.kind as NotificationKind,
    refType: r.refType,
    refId: r.refId,
    title: r.title,
    body: r.body,
    actor: actor && actor.id ? { id: actor.id, handle: actor.handle, displayName: actor.displayName } : null,
    novelId: r.refType === 'novel' ? r.refId : novelId,
    readAt: isoOrNull(r.readAt),
    createdAt: iso(r.createdAt),
  };
}

export function unreadCount(deps: AppDeps, userId: string): number {
  const row = deps.db
    .select({ c: sql<number>`count(*)` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .get();
  return row?.c ?? 0;
}

export function listNotifications(deps: AppDeps, user: AuthUser, q: NotificationQuery): NotificationListResponse {
  const conds: SQL[] = [eq(notifications.userId, user.id)];
  if (q.filter === 'unread') conds.push(isNull(notifications.readAt));
  const cursor = decodeCursor(q.cursor);
  if (cursor) {
    conds.push(
      or(
        lt(notifications.createdAt, new Date(cursor.v)),
        and(eq(notifications.createdAt, new Date(cursor.v)), lt(notifications.id, cursor.id)),
      )!,
    );
  }
  // 留言类通知要知道落到哪本书；左连接一次拿到，避免逐条回查。
  const rows = deps.db
    .select({
      n: notifications,
      actor: { id: users.id, handle: users.handle, displayName: users.displayName },
      novelId: comments.novelId,
    })
    .from(notifications)
    .leftJoin(users, eq(users.id, notifications.actorId))
    .leftJoin(comments, and(eq(notifications.refType, 'comment'), eq(comments.id, notifications.refId)))
    .where(and(...conds))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(q.limit + 1)
    .all();
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => toNotification(r.n, r.actor as ActorParts, r.novelId ?? null)),
    nextCursor: rows.length > q.limit && last ? encodeCursor({ v: last.n.createdAt.getTime(), id: last.n.id }) : null,
    unreadCount: unreadCount(deps, user.id),
  };
}

/** 批量已读。只动自己的通知，且只动未读的（已读的不再刷新时间戳）。 */
export function markRead(deps: AppDeps, user: AuthUser, req: MarkNotificationsReadRequest): { updated: number; unreadCount: number } {
  const now = deps.clock.now();
  const scope = and(eq(notifications.userId, user.id), isNull(notifications.readAt))!;
  const where = req.all === true ? scope : and(scope, inArray(notifications.id, req.ids ?? []))!;
  const res = deps.db.update(notifications).set({ readAt: now }).where(where).run();
  return { updated: changes(res), unreadCount: unreadCount(deps, user.id) };
}

/** 作品标题（通知文案要用），查不到时给个占位。 */
export function novelTitleOf(ex: Executor, novelId: string): string {
  return ex.select({ t: novels.title }).from(novels).where(eq(novels.id, novelId)).get()?.t ?? '这个故事';
}
