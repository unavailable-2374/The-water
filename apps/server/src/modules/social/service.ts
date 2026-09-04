import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
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
  const base = eq(likes.userId, user.id);
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
    // 已下架/隐藏的小说仍保留在“我的点赞”中，但仅展示可公开的。
    items: page.filter((r) => isPubliclyViewable(r.n)).map((r) => toNovelSummary(r.n, r.author)),
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

export function createReport(
  deps: AppDeps,
  novelId: string,
  viewer: Viewer,
  req: z.infer<typeof CreateReportRequestSchema>,
): Report {
  loadViewableNovel(deps, novelId, viewer);
  const row: typeof reports.$inferInsert = {
    id: newId(),
    novelId,
    commentId: null,
    reporterId: viewer?.id ?? null,
    reason: req.reason,
    detail: req.detail ?? null,
    status: 'open',
    createdAt: deps.clock.now(),
  };
  deps.db.insert(reports).values(row).run();
  return toReport(deps.db.select().from(reports).where(eq(reports.id, row.id!)).get()!);
}
