import { and, desc, eq, lt, or } from 'drizzle-orm';
import type { NovelDetail, Page } from '@the-water/shared';
import type { AppDeps, AuthUser } from '../../context';
import { novels, reports } from '../../db/schema';
import { decodeCursor, encodeCursor } from '../../lib/cursor';
import { notFound } from '../../lib/errors';
import { setCommentStatus } from '../comments/service';
import { reverseNovelPoints } from '../incentive/service';
import { buildNovelDetail, findNovelRow } from '../novels/service';
import { toReport, type Report } from '../social/service';

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
    if (moderationStatus !== 'ok') {
      // 处理中的举报视为已处理。
      tx.update(reports).set({ status: 'resolved', resolvedAt: now, note: note ?? null }).where(and(eq(reports.novelId, novelId), eq(reports.status, 'open'))).run();
      // 账本不删，用一笔负数抵消，历史仍然可查。
      if (reversePoints) reverseNovelPoints(deps, tx, novelId);
    }
  });
  return buildNovelDetail(deps, findNovelRow(deps, novelId)!, admin);
}

export function resolveReport(deps: AppDeps, reportId: string, status: 'resolved' | 'dismissed', note: string | undefined): Report {
  const r = deps.db.select().from(reports).where(eq(reports.id, reportId)).get();
  if (!r) throw notFound('举报');
  deps.db.update(reports).set({ status, note: note ?? null, resolvedAt: deps.clock.now() }).where(eq(reports.id, reportId)).run();
  return toReport(deps.db.select().from(reports).where(eq(reports.id, reportId)).get()!);
}

/** 管理员隐藏或恢复一条留言。隐藏后的渲染与用户自行删除相同。 */
export function setCommentModeration(
  deps: AppDeps,
  admin: AuthUser,
  novelId: string,
  commentId: string,
  status: 'ok' | 'hidden',
) {
  const comment = setCommentStatus(deps, admin, novelId, commentId, status);
  if (status !== 'ok') {
    deps.db
      .update(reports)
      .set({ status: 'resolved', resolvedAt: deps.clock.now() })
      .where(and(eq(reports.commentId, commentId), eq(reports.status, 'open')))
      .run();
  }
  return comment;
}
