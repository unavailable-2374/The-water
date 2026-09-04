import { and, desc, eq, like, lt, or, type SQL } from 'drizzle-orm';
import type { AdminUser, ModerationEvent, NovelDetail, Page } from '@the-water/shared';
import type { AppDeps, AuthUser } from '../../context';
import { comments, novels, reports, users, type UserRow } from '../../db/schema';
import { decodeCursor, encodeCursor } from '../../lib/cursor';
import { forbidden, notFound, validation } from '../../lib/errors';
import { iso, isoOrNull } from '../../lib/time';
import { setCommentStatus } from '../comments/service';
import { reverseNovelPoints } from '../incentive/service';
import { notifyCommentModeration, notifyNovelModeration } from '../notifications/service';
import { buildNovelDetail, findNovelRow } from '../novels/service';
import { toReport, type Report } from '../social/service';
import { findUserRow } from '../users/service';
import { listModerationEvents, recordModerationEvent, type ModerationEventFilter } from './audit';
import { syncNovelTags } from '../novels/tags';

export { listModerationEvents };
export type { ModerationEventFilter };

export function listReports(
  deps: AppDeps,
  status: 'open' | 'resolved' | 'dismissed' | undefined,
  cursorRaw: string | undefined,
  limit: number,
): Page<Report> {
  const cursor = decodeCursor(cursorRaw);
  const conds = [];
  if (status) conds.push(eq(reports.status, status));
  if (cursor) {
    conds.push(or(lt(reports.createdAt, new Date(cursor.v)), and(eq(reports.createdAt, new Date(cursor.v)), lt(reports.id, cursor.id)))!);
  }
  const rows = deps.db
    .select()
    .from(reports)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(reports.createdAt), desc(reports.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toReport),
    nextCursor: rows.length > limit && last ? encodeCursor({ v: last.createdAt.getTime(), id: last.id }) : null,
  };
}

export function setModeration(
  deps: AppDeps,
  admin: AuthUser,
  novelId: string,
  moderationStatus: 'ok' | 'hidden' | 'removed',
  note: string | undefined,
  reversePoints = false,
): NovelDetail {
  const n = findNovelRow(deps, novelId);
  if (!n || n.deletedAt !== null) throw notFound('小说');
  const now = deps.clock.now();
  deps.db.transaction((tx) => {
    tx.update(novels).set({ moderationStatus, moderationNote: note ?? null, updatedAt: now }).where(eq(novels.id, novelId)).run();
    // 审核隐藏 / 恢复会改变「这本书算不算进标签计数」（§3.4）。
    syncNovelTags(deps, tx, novelId);
    if (moderationStatus !== 'ok') {
      // 处理中的举报视为已处理。
      tx.update(reports).set({ status: 'resolved', resolvedAt: now, note: note ?? null }).where(and(eq(reports.novelId, novelId), eq(reports.status, 'open'))).run();
      // 账本不删，用一笔负数抵消，历史仍然可查。
      if (reversePoints) reverseNovelPoints(deps, tx, novelId);
    }
    // §3.1：作者要知道自己的作品被隐藏 / 下架 / 恢复了。状态没变就不打扰。
    if (moderationStatus !== n.moderationStatus) notifyNovelModeration(deps, tx, n, moderationStatus, note ?? null);
    // 每一次处置都要能追溯到人。
    recordModerationEvent(
      deps,
      {
        actorId: admin.id,
        targetType: 'novel',
        targetId: novelId,
        action: moderationStatus === 'ok' ? 'novel_restore' : moderationStatus === 'hidden' ? 'novel_hide' : 'novel_remove',
        note: note ?? null,
        meta: { from: n.moderationStatus, to: moderationStatus, reversePoints, authorId: n.authorId },
      },
      tx,
    );
  });
  return buildNovelDetail(deps, findNovelRow(deps, novelId)!, admin);
}

export function resolveReport(
  deps: AppDeps,
  admin: AuthUser,
  reportId: string,
  status: 'resolved' | 'dismissed',
  note: string | undefined,
): Report {
  const r = deps.db.select().from(reports).where(eq(reports.id, reportId)).get();
  if (!r) throw notFound('举报');
  deps.db.transaction((tx) => {
    tx.update(reports).set({ status, note: note ?? null, resolvedAt: deps.clock.now() }).where(eq(reports.id, reportId)).run();
    recordModerationEvent(
      deps,
      {
        actorId: admin.id,
        targetType: 'report',
        targetId: reportId,
        action: status === 'resolved' ? 'report_resolve' : 'report_dismiss',
        note: note ?? null,
        meta: { novelId: r.novelId, commentId: r.commentId, reason: r.reason },
      },
      tx,
    );
  });
  return toReport(deps.db.select().from(reports).where(eq(reports.id, reportId)).get()!);
}

/** 管理员隐藏或恢复一条留言。隐藏后的渲染与用户自行删除相同。 */
export function setCommentModeration(
  deps: AppDeps,
  admin: AuthUser,
  novelId: string,
  commentId: string,
  status: 'ok' | 'hidden',
  note?: string,
) {
  const before = deps.db.select().from(comments).where(eq(comments.id, commentId)).get();
  const comment = setCommentStatus(deps, admin, novelId, commentId, status);
  // 状态真的变了才通知留言作者（重复点隐藏不该刷屏）。
  if (before && before.status !== status && (status === 'hidden' || before.status === 'hidden')) {
    const title = deps.db.select({ t: novels.title }).from(novels).where(eq(novels.id, novelId)).get()?.t ?? '这个故事';
    notifyCommentModeration(deps, deps.db, before, title, status, note ?? null);
  }
  if (status !== 'ok') {
    deps.db
      .update(reports)
      .set({ status: 'resolved', resolvedAt: deps.clock.now() })
      .where(and(eq(reports.commentId, commentId), eq(reports.status, 'open')))
      .run();
  }
  recordModerationEvent(deps, {
    actorId: admin.id,
    targetType: 'comment',
    targetId: commentId,
    action: status === 'ok' ? 'comment_restore' : 'comment_hide',
    note: note ?? null,
    meta: { novelId },
  });
  return comment;
}

/** `/admin/comments/:id/...` 只给留言 id，novelId 从行里取。 */
export function setCommentModerationById(deps: AppDeps, admin: AuthUser, commentId: string, status: 'ok' | 'hidden', note?: string) {
  const row = deps.db.select({ novelId: comments.novelId }).from(comments).where(eq(comments.id, commentId)).get();
  if (!row) throw notFound('留言');
  return setCommentModeration(deps, admin, row.novelId, commentId, status, note);
}

// ---- 账号封禁 ----

export function toAdminUser(u: UserRow): AdminUser {
  return {
    id: u.id,
    email: u.email,
    handle: u.handle,
    displayName: u.displayName,
    role: u.role,
    status: u.status,
    suspendedUntil: isoOrNull(u.suspendedUntil),
    statusReason: u.statusReason,
    createdAt: iso(u.createdAt),
  };
}

/**
 * 封禁账号。until 为空即永久 banned；有值则 suspended 且到期自动恢复（见 middleware/auth.ts）。
 * 管理员之间不能互封，避免一次误操作把后台锁死。
 */
export function banUser(deps: AppDeps, admin: AuthUser, userId: string, reason: string, untilRaw?: string): AdminUser {
  const u = findUserRow(deps, userId);
  if (!u) throw notFound('用户');
  if (u.id === admin.id) throw validation('不能封禁自己');
  if (u.role === 'admin') throw forbidden('不能封禁管理员');
  const now = deps.clock.now();
  const until = untilRaw ? new Date(untilRaw) : null;
  if (until && (Number.isNaN(until.getTime()) || until.getTime() <= now.getTime())) {
    throw validation('解禁时间必须晚于当前时间');
  }
  const status = until ? 'suspended' : 'banned';
  deps.db.transaction((tx) => {
    tx.update(users)
      .set({ status, suspendedUntil: until, statusReason: reason, updatedAt: now })
      .where(eq(users.id, userId))
      .run();
    recordModerationEvent(
      deps,
      {
        actorId: admin.id,
        targetType: 'user',
        targetId: userId,
        action: until ? 'user_suspend' : 'user_ban',
        reason,
        meta: { until: until ? iso(until) : null, from: u.status },
      },
      tx,
    );
  });
  return toAdminUser(findUserRow(deps, userId)!);
}

export function unbanUser(deps: AppDeps, admin: AuthUser, userId: string, note?: string): AdminUser {
  const u = findUserRow(deps, userId);
  if (!u) throw notFound('用户');
  const now = deps.clock.now();
  deps.db.transaction((tx) => {
    tx.update(users)
      .set({ status: 'active', suspendedUntil: null, statusReason: null, updatedAt: now })
      .where(eq(users.id, userId))
      .run();
    recordModerationEvent(
      deps,
      { actorId: admin.id, targetType: 'user', targetId: userId, action: 'user_unban', note: note ?? null, meta: { from: u.status } },
      tx,
    );
  });
  return toAdminUser(findUserRow(deps, userId)!);
}

export interface AdminUserQuery {
  q?: string;
  status?: 'active' | 'suspended' | 'banned';
  cursor?: string;
  limit: number;
}

/** 用户检索：邮箱 / handle / 昵称模糊匹配 + 状态筛选，按注册时间倒序分页。 */
export function listUsers(deps: AppDeps, q: AdminUserQuery): Page<AdminUser> {
  const conds: SQL[] = [];
  if (q.status) conds.push(eq(users.status, q.status));
  if (q.q) {
    const needle = `%${q.q.trim().toLowerCase()}%`;
    conds.push(or(like(users.email, needle), like(users.handle, needle), like(users.displayName, `%${q.q.trim()}%`))!);
  }
  const cursor = decodeCursor(q.cursor);
  if (cursor) {
    conds.push(
      or(lt(users.createdAt, new Date(cursor.v)), and(eq(users.createdAt, new Date(cursor.v)), lt(users.id, cursor.id)))!,
    );
  }
  const rows = deps.db
    .select()
    .from(users)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(q.limit + 1)
    .all();
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toAdminUser),
    nextCursor: rows.length > q.limit && last ? encodeCursor({ v: last.createdAt.getTime(), id: last.id }) : null,
  };
}

export type { ModerationEvent };
