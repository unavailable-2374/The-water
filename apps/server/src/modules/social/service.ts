import { and, desc, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { NovelSummary, Page, ReportSchema, CreateReportRequestSchema } from '@the-water/shared';
import type { z } from 'zod';
import type { AppDeps, AuthUser } from '../../context';
import { changes } from '../../db/client';
import { likes, novels, reports, users, viewEvents, type ReportRow } from '../../db/schema';
import { newId } from '../../lib/ids';
import { decodeCursor, encodeCursor } from '../../lib/cursor';
import { dayKey, iso } from '../../lib/time';
import { toNovelSummary } from '../novels/dto';
import { findNovelRow, isPubliclyViewable, loadViewableNovel, type Viewer } from '../novels/service';
import { assertNotBlocked } from '../users/blocking';
import { awardLike, awardView } from '../incentive/service';

export type Report = z.infer<typeof ReportSchema>;

export function toReport(r: ReportRow): Report {
  return {
    id: r.id,
    novelId: r.novelId,
    commentId: r.commentId,
    reporterId: r.reporterId,
    reason: r.reason,
    detail: r.detail,
    status: r.status,
    createdAt: iso(r.createdAt),
  };
}

function likeCountOf(deps: AppDeps, novelId: string): number {
  return deps.db.select({ c: novels.likeCount }).from(novels).where(eq(novels.id, novelId)).get()?.c ?? 0;
}

export function like(deps: AppDeps, user: AuthUser, novelId: string): { liked: boolean; likeCount: number } {
  const novel = loadViewableNovel(deps, novelId, user);
  assertNotBlocked(deps, user.id, novel.authorId);
  deps.db.transaction((tx) => {
    const res = tx.insert(likes).values({ userId: user.id, novelId, createdAt: deps.clock.now() }).onConflictDoNothing().run();
    if (changes(res) > 0) {
      tx.update(novels).set({ likeCount: sql`${novels.likeCount} + 1` }).where(eq(novels.id, novelId)).run();
      awardLike(deps, tx, novel, user.id);
    }
  });
  return { liked: true, likeCount: likeCountOf(deps, novelId) };
}

export function unlike(deps: AppDeps, user: AuthUser, novelId: string): { liked: boolean; likeCount: number } {
  loadViewableNovel(deps, novelId, user);
  deps.db.transaction((tx) => {
    const res = tx.delete(likes).where(and(eq(likes.userId, user.id), eq(likes.novelId, novelId))).run();
    if (changes(res) > 0) {
      tx.update(novels).set({ likeCount: sql`max(${novels.likeCount} - 1, 0)` }).where(eq(novels.id, novelId)).run();
    }
  });
  return { liked: false, likeCount: likeCountOf(deps, novelId) };
}

export function listMyLikes(deps: AppDeps, user: AuthUser, cursorRaw: string | undefined, limit: number): Page<NovelSummary> {
  const cursor = decodeCursor(cursorRaw);
  // §4.6：可见性必须下推进 SQL。先按 limit 切页、再在应用层过滤，会让页面变短却仍返回非空
  // nextCursor（客户端看到「一页 3 条却还有下一页」）。这里的谓词与 isPubliclyViewable 等价
  // —— 刻意不用 browse 的 publicListWhere()，那个更严，会把 unlisted 的已赞作品也踢掉。
  const base = and(
    eq(likes.userId, user.id),
    isNull(novels.deletedAt),
    ne(novels.visibility, 'unpublished'),
    eq(novels.moderationStatus, 'ok'),
  )!;
  const where = cursor
    ? and(base, or(lt(likes.createdAt, new Date(cursor.v)), and(eq(likes.createdAt, new Date(cursor.v)), lt(likes.novelId, cursor.id))))
    : base;
  const rows = deps.db
    .select({ l: likes, n: novels, author: { id: users.id, displayName: users.displayName, handle: users.handle } })
    .from(likes)
    .innerJoin(novels, eq(novels.id, likes.novelId))
    .innerJoin(users, eq(users.id, novels.authorId))
    .where(where)
    .orderBy(desc(likes.createdAt), desc(likes.novelId))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    // 已下架 / 隐藏的小说仍保留在「我的点赞」里，只是不展示（上面的 where 已排除）。
    items: page.map((r) => toNovelSummary(r.n, r.author)),
    nextCursor: rows.length > limit && last ? encodeCursor({ v: last.l.createdAt.getTime(), id: last.l.novelId }) : null,
  };
}

/** 每访客每日去重计浏览。 */
export function recordView(deps: AppDeps, novelId: string, viewerKey: string, viewer: Viewer): { viewCount: number; counted: boolean } {
  const novel = loadViewableNovel(deps, novelId, viewer);
  if (!isPubliclyViewable(novel)) return { viewCount: novel.viewCount, counted: false };
  let counted = false;
  deps.db.transaction((tx) => {
    const res = tx.insert(viewEvents).values({ novelId, viewerKey, day: dayKey(deps.clock.now()) }).onConflictDoNothing().run();
    if (changes(res) > 0) {
      counted = true;
      tx.update(novels).set({ viewCount: sql`${novels.viewCount} + 1` }).where(eq(novels.id, novelId)).run();
      awardView(deps, tx, novel, viewerKey);
    }
  });
  const fresh = findNovelRow(deps, novelId)!;
  return { viewCount: fresh.viewCount, counted };
}

/** 同人同对象只留一条：`${novelId}:${commentId ?? '-'}:${reporterId ?? viewerKey}`。 */
export function reportDedupeKey(novelId: string, commentId: string | null, reporterKey: string): string {
  return `${novelId}:${commentId ?? '-'}:${reporterKey}`;
}

export interface ReportInput {
  novelId: string;
  commentId: string | null;
  reporterId: string | null;
  /** 未登录时的兜底身份（当前举报要求登录，保留是为了将来放开匿名举报）。 */
  viewerKey: string;
  reason: z.infer<typeof CreateReportRequestSchema>['reason'];
  detail?: string | null;
}

/**
 * 写入一条举报。重复举报同一对象直接返回既有记录，不报错也不新增队列条目
 * （§3.3：举报队列曾可零成本刷爆）。
 */
export function insertReport(deps: AppDeps, input: ReportInput): ReportRow {
  const dedupeKey = reportDedupeKey(input.novelId, input.commentId, input.reporterId ?? input.viewerKey);
  const row: typeof reports.$inferInsert = {
    id: newId(),
    novelId: input.novelId,
    commentId: input.commentId,
    reporterId: input.reporterId,
    dedupeKey,
    reason: input.reason,
    detail: input.detail ?? null,
    status: 'open',
    createdAt: deps.clock.now(),
  };
  const res = deps.db.insert(reports).values(row).onConflictDoNothing().run();
  if (changes(res) > 0) return deps.db.select().from(reports).where(eq(reports.id, row.id!)).get()!;
  return deps.db.select().from(reports).where(eq(reports.dedupeKey, dedupeKey)).get()!;
}

export function createReport(
  deps: AppDeps,
  novelId: string,
  user: AuthUser,
  viewerKey: string,
  req: z.infer<typeof CreateReportRequestSchema>,
): Report {
  loadViewableNovel(deps, novelId, user);
  return toReport(
    insertReport(deps, { novelId, commentId: null, reporterId: user.id, viewerKey, reason: req.reason, detail: req.detail ?? null }),
  );
}
