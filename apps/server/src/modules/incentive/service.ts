/**
 * 激励计划：point_ledger 是唯一真相，users.points 是它在同一事务里维护的缓存合计。
 * 每条规则都有确定性的 dedupeKey（唯一索引兜底），所以同一件事重复触发只加一次分；
 * 撤销（取消喜欢、取关、删留言）一律不扣分，规则简单，也不会被人刷成负分。
 */
import { and, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import {
  BADGE_BY_ID,
  DERIVATIVE_VIEW_SPLIT,
  POINT_KIND_LABELS,
  POINT_RULES,
  PUBLISH_POINTS,
  badgesFor,
  levelFor,
  type BadgeId,
  type BadgeStats,
  type LeaderboardQuery,
  type LeaderboardResponse,
  type MyPointsResponse,
  type Page,
  type PointKind,
  type PointsLedgerEntry,
} from '@the-water/shared';
import type { AppDeps, AuthUser } from '../../context';
import { changes } from '../../db/client';
import { forks, novels, pointLedger, userBadges, users, type NovelRow } from '../../db/schema';
import { decodeCursor, encodeCursor } from '../../lib/cursor';
import { newId } from '../../lib/ids';
import { DAY, iso } from '../../lib/time';
import { notifyBadge, notifyFollow, notifyFork, notifyLike } from '../notifications/service';
import { publicListWhere } from '../browse/service';
import { toNovelSummary } from '../novels/dto';
import { toUserCard } from '../users/service';
import { getCached } from '../../lib/cache';

/** Db 与事务共有的部分：积分写入既可以独立执行，也可以挂在调用方事务里。 */
export type Executor = Pick<AppDeps['db'], 'select' | 'insert' | 'update' | 'delete'>;

export interface AwardInput {
  /** 受益人。 */
  userId: string;
  /** 触发者；与受益人相同则不计分（自赞、自读、自评都是 0）。匿名为 null。 */
  actorId: string | null;
  kind: PointKind;
  /** 覆盖规则默认分值（首发原创/二创、二创浏览分账用）。 */
  points?: number;
  refType: 'novel' | 'user' | 'comment';
  refId: string;
  dedupeKey: string;
  /** 规则的日上限作用于小说时，这里给出那本小说的 id。 */
  capScopeId?: string;
  meta?: Record<string, unknown>;
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function dayKeyOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function underDailyCap(deps: AppDeps, ex: Executor, input: AwardInput): boolean {
  const rule = input.kind === 'adjustment' ? undefined : POINT_RULES[input.kind];
  const cap = rule?.dailyCap;
  if (!cap) return true;
  const since = startOfUtcDay(deps.clock.now());
  const scope =
    cap.scope === 'user'
      ? eq(pointLedger.userId, input.userId)
      : and(eq(pointLedger.refType, 'novel'), eq(pointLedger.refId, input.capScopeId ?? input.refId));
  const row = ex
    .select({ c: sql<number>`count(*)` })
    .from(pointLedger)
    .where(and(eq(pointLedger.kind, input.kind), gte(pointLedger.createdAt, since), scope))
    .get();
  return (row?.c ?? 0) < cap.max;
}

/**
 * 记一笔积分。返回是否真的记上了（幂等键命中、自触发、超日上限都会返回 false）。
 * 必须在调用方的事务里执行，保证账本与 users.points 不会各说各话。
 */
export function award(deps: AppDeps, ex: Executor, input: AwardInput): { awarded: boolean; points: number } {
  if (input.actorId && input.actorId === input.userId) return { awarded: false, points: 0 };
  const points = input.points ?? (input.kind === 'adjustment' ? 0 : POINT_RULES[input.kind].points);
  if (!points) return { awarded: false, points: 0 };
  if (!underDailyCap(deps, ex, input)) return { awarded: false, points: 0 };

  const res = ex
    .insert(pointLedger)
    .values({
      id: newId(),
      userId: input.userId,
      kind: input.kind,
      points,
      refType: input.refType,
      refId: input.refId,
      dedupeKey: input.dedupeKey,
      meta: input.meta ?? null,
      createdAt: deps.clock.now(),
    })
    .onConflictDoNothing()
    .run();
  if (changes(res) === 0) return { awarded: false, points: 0 };

  ex.update(users)
    .set({ points: sql`max(${users.points} + ${points}, 0)` })
    .where(eq(users.id, input.userId))
    .run();

  // 徽章只在里程碑事件后重算，避免每次加分都跑一遍聚合。
  if (MILESTONE_KINDS.has(input.kind)) maybeAwardBadges(deps, ex, input.userId);
  return { awarded: true, points };
}

const MILESTONE_KINDS = new Set<PointKind>([
  'novel_published',
  'novel_completed',
  'like_received',
  'fork_received',
  'follower_gained',
  'adjustment',
]);

export function badgeStatsOf(deps: AppDeps, ex: Executor, userId: string): BadgeStats {
  const u = ex.select().from(users).where(eq(users.id, userId)).get();
  if (!u) return { points: 0, novelCount: 0, derivativeCount: 0, derivedCount: 0, followerCount: 0, likeReceived: 0, commentReceived: 0 };
  const agg = ex
    .select({
      novelCount: sql<number>`sum(case when ${novels.sourceNovelId} is null then 1 else 0 end)`,
      derivativeCount: sql<number>`sum(case when ${novels.sourceNovelId} is not null then 1 else 0 end)`,
      likeReceived: sql<number>`coalesce(sum(${novels.likeCount}), 0)`,
      commentReceived: sql<number>`coalesce(sum(${novels.commentCount}), 0)`,
    })
    .from(novels)
    .where(and(eq(novels.authorId, userId), publicListWhere()))
    .get();
  const derived = ex
    .select({ c: sql<number>`count(*)` })
    .from(forks)
    .innerJoin(novels, eq(novels.id, forks.sourceNovelId))
    .where(eq(novels.authorId, userId))
    .get();
  return {
    points: u.points,
    novelCount: agg?.novelCount ?? 0,
    derivativeCount: agg?.derivativeCount ?? 0,
    derivedCount: derived?.c ?? 0,
    followerCount: u.followerCount,
    likeReceived: agg?.likeReceived ?? 0,
    commentReceived: agg?.commentReceived ?? 0,
  };
}

export function maybeAwardBadges(deps: AppDeps, ex: Executor, userId: string): BadgeId[] {
  const earned = badgesFor(badgeStatsOf(deps, ex, userId));
  const now = deps.clock.now();
  for (const badge of earned) {
    const res = ex.insert(userBadges).values({ userId, badge, awardedAt: now }).onConflictDoNothing().run();
    // 只有真正第一次拿到才通知；重算徽章不会反复打扰。
    if (changes(res) > 0) notifyBadge(deps, ex, userId, badge);
  }
  return earned;
}

// ---- 各处的记分入口 ----

export function awardPublish(deps: AppDeps, ex: Executor, novel: NovelRow, firstVersion: boolean): void {
  if (firstVersion) {
    award(deps, ex, {
      userId: novel.authorId,
      actorId: null,
      kind: 'novel_published',
      points: novel.sourceNovelId ? PUBLISH_POINTS.derivative : PUBLISH_POINTS.original,
      refType: 'novel',
      refId: novel.id,
      dedupeKey: `novel_published:${novel.id}`,
    });
    return;
  }
  // 每本小说每天最多为一次更新计分，防止连发小版本刷分。
  award(deps, ex, {
    userId: novel.authorId,
    actorId: null,
    kind: 'version_published',
    refType: 'novel',
    refId: novel.id,
    dedupeKey: `version_published:${novel.id}:${dayKeyOf(deps.clock.now())}`,
  });
}

export function awardCompleted(deps: AppDeps, ex: Executor, novel: NovelRow): void {
  award(deps, ex, {
    userId: novel.authorId,
    actorId: null,
    kind: 'novel_completed',
    refType: 'novel',
    refId: novel.id,
    dedupeKey: `novel_completed:${novel.id}`,
  });
}

export function awardLike(deps: AppDeps, ex: Executor, novel: NovelRow, likerId: string): void {
  // 通知与积分各有各的去重键：日上限吃掉的分不该顺带吃掉通知。
  notifyLike(deps, ex, novel, likerId);
  award(deps, ex, {
    userId: novel.authorId,
    actorId: likerId,
    kind: 'like_received',
    refType: 'novel',
    refId: novel.id,
    dedupeKey: `like_received:${novel.id}:${likerId}`,
  });
}

export function awardFork(deps: AppDeps, ex: Executor, novel: NovelRow, forkerId: string): void {
  notifyFork(deps, ex, novel, forkerId);
  award(deps, ex, {
    userId: novel.authorId,
    actorId: forkerId,
    kind: 'fork_received',
    refType: 'novel',
    refId: novel.id,
    dedupeKey: `fork_received:${novel.id}:${forkerId}`,
  });
}

/**
 * 浏览计分。原创全额给作者；二创拆成两笔：大头给二创作者，一小份给直接来源的作者
 * （只上溯一层，不沿谱系一路分下去）。viewerKey 形如 user:<id> / client:<id> / ip:<addr>。
 */
export function awardView(deps: AppDeps, ex: Executor, novel: NovelRow, viewerKey: string): void {
  const day = dayKeyOf(deps.clock.now());
  const viewerId = viewerKey.startsWith('user:') ? viewerKey.slice(5) : null;
  const derivative = novel.sourceNovelId !== null;

  award(deps, ex, {
    userId: novel.authorId,
    actorId: viewerId,
    kind: 'view_received',
    points: derivative ? DERIVATIVE_VIEW_SPLIT.derivative : POINT_RULES.view_received.points,
    refType: 'novel',
    refId: novel.id,
    dedupeKey: `view_received:${novel.id}:${viewerKey}:${day}`,
    capScopeId: novel.id,
  });

  if (!derivative) return;
  const source = ex.select().from(novels).where(eq(novels.id, novel.sourceNovelId!)).get();
  if (!source || source.authorId === novel.authorId) return;
  // 日上限按来源作品计（每本原作每天最多分成 30 次），因此这里不传 capScopeId：
  // 账本行的 refId 就是来源作品，计数与写入用同一个键才对得上。
  award(deps, ex, {
    userId: source.authorId,
    actorId: viewerId,
    kind: 'view_shared',
    refType: 'novel',
    refId: source.id,
    dedupeKey: `view_shared:${novel.id}:${viewerKey}:${day}`,
    meta: { viaNovelId: novel.id },
  });
}

export function awardFollow(deps: AppDeps, ex: Executor, followeeId: string, followerId: string): void {
  notifyFollow(deps, ex, followeeId, followerId);
  award(deps, ex, {
    userId: followeeId,
    actorId: followerId,
    kind: 'follower_gained',
    refType: 'user',
    refId: followerId,
    dedupeKey: `follower_gained:${followeeId}:${followerId}`,
  });
}

export function awardComment(
  deps: AppDeps,
  ex: Executor,
  ctx: { commentId: string; authorId: string; novelId: string; novelAuthorId: string },
): void {
  award(deps, ex, {
    userId: ctx.authorId,
    actorId: null,
    kind: 'comment_posted',
    refType: 'comment',
    refId: ctx.commentId,
    dedupeKey: `comment_posted:${ctx.commentId}`,
  });
  award(deps, ex, {
    userId: ctx.novelAuthorId,
    actorId: ctx.authorId,
    kind: 'comment_received',
    refType: 'comment',
    refId: ctx.commentId,
    dedupeKey: `comment_received:${ctx.commentId}`,
    capScopeId: ctx.novelId,
  });
}

/** 管理员下架作品时按人冲正它产生过的积分（账本保留，用一笔负数抵消）。 */
export function reverseNovelPoints(deps: AppDeps, ex: Executor, novelId: string): number {
  const rows = ex
    .select({ userId: pointLedger.userId, total: sql<number>`sum(${pointLedger.points})` })
    .from(pointLedger)
    .where(and(eq(pointLedger.refType, 'novel'), eq(pointLedger.refId, novelId)))
    .groupBy(pointLedger.userId)
    .all();
  let reversed = 0;
  for (const r of rows) {
    if (!r.total) continue;
    const ok = award(deps, ex, {
      userId: r.userId,
      actorId: null,
      kind: 'adjustment',
      points: -r.total,
      refType: 'novel',
      refId: novelId,
      dedupeKey: `adjustment:reverse:${novelId}:${r.userId}`,
      meta: { reason: 'moderation' },
    });
    if (ok.awarded) reversed += 1;
  }
  return reversed;
}

// ---- 读取 ----

export function myPoints(deps: AppDeps, user: AuthUser, cursorRaw: string | undefined, limit: number): MyPointsResponse {
  const row = deps.db.select({ points: users.points }).from(users).where(eq(users.id, user.id)).get();
  const points = row?.points ?? 0;
  const badges = deps.db
    .select()
    .from(userBadges)
    .where(eq(userBadges.userId, user.id))
    .orderBy(desc(userBadges.awardedAt))
    .all()
    .map((b) => ({ id: b.badge as BadgeId, awardedAt: iso(b.awardedAt) }))
    .filter((b) => !!BADGE_BY_ID[b.id]);

  const cursor = decodeCursor(cursorRaw);
  const base = eq(pointLedger.userId, user.id);
  const where = cursor
    ? and(
        base,
        or(
          lt(pointLedger.createdAt, new Date(cursor.v)),
          and(eq(pointLedger.createdAt, new Date(cursor.v)), lt(pointLedger.id, cursor.id)),
        ),
      )
    : base;
  const rows = deps.db
    .select()
    .from(pointLedger)
    .where(where)
    .orderBy(desc(pointLedger.createdAt), desc(pointLedger.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const ledger: Page<PointsLedgerEntry> = {
    items: page.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: POINT_KIND_LABELS[r.kind as PointKind] ?? r.kind,
      points: r.points,
      refType: r.refType,
      refId: r.refId,
      createdAt: iso(r.createdAt),
    })),
    nextCursor: rows.length > limit && last ? encodeCursor({ v: last.createdAt.getTime(), id: last.id }) : null,
  };
  return { points, level: levelFor(points), badges, ledger };
}

const BOARD_SIZE = 50;
const CACHE_TTL_MS = 120_000;

function periodStart(deps: AppDeps, period: LeaderboardQuery['period']): Date | null {
  if (period === 'all') return null;
  // 滚动 7 / 30 天，不必处理自然周月与时区。
  return new Date(deps.clock.now().getTime() - (period === 'week' ? 7 : 30) * DAY);
}

export function leaderboard(deps: AppDeps, q: LeaderboardQuery): LeaderboardResponse {
  const since = periodStart(deps, q.period);
  const generatedAt = iso(deps.clock.now());
  if (q.board === 'authors') {
    const ranked =
      since === null
        ? deps.db.select().from(users).orderBy(desc(users.points), users.id).limit(BOARD_SIZE).all().map((u) => ({ u, points: u.points }))
        : deps.db
            .select({ userId: pointLedger.userId, total: sql<number>`sum(${pointLedger.points})`.as('total') })
            .from(pointLedger)
            .where(gte(pointLedger.createdAt, since))
            .groupBy(pointLedger.userId)
            .orderBy(desc(sql`total`), pointLedger.userId)
            .limit(BOARD_SIZE)
            .all()
            .flatMap((r) => {
              const u = deps.db.select().from(users).where(eq(users.id, r.userId)).get();
              return u && r.total > 0 ? [{ u, points: r.total }] : [];
            });
    return {
      board: 'authors',
      period: q.period,
      generatedAt,
      authors: ranked.filter((r) => r.points > 0).map((r, i) => ({ ...toUserCard(r.u), rank: i + 1, points: r.points })),
      novels: null,
    };
  }

  const sums = deps.db
    .select({ refId: pointLedger.refId, total: sql<number>`sum(${pointLedger.points})`.as('total') })
    .from(pointLedger)
    .where(since === null ? eq(pointLedger.refType, 'novel') : and(eq(pointLedger.refType, 'novel'), gte(pointLedger.createdAt, since)))
    .groupBy(pointLedger.refId)
    .orderBy(desc(sql`total`), pointLedger.refId)
    .limit(BOARD_SIZE * 2)
    .all()
    .filter((r) => r.total > 0);
  if (!sums.length) return { board: 'novels', period: q.period, generatedAt, authors: null, novels: [] };

  const rows = deps.db
    .select({ n: novels, author: { id: users.id, displayName: users.displayName, handle: users.handle } })
    .from(novels)
    .innerJoin(users, eq(users.id, novels.authorId))
    .where(and(inArray(novels.id, sums.map((s) => s.refId)), publicListWhere()))
    .all();
  const byId = new Map(rows.map((r) => [r.n.id, r]));
  const items = sums
    .flatMap((s) => {
      const row = byId.get(s.refId);
      return row ? [{ ...toNovelSummary(row.n, row.author), points: s.total }] : [];
    })
    .slice(0, BOARD_SIZE)
    .map((n, i) => ({ ...n, rank: i + 1 }));
  return { board: 'novels', period: q.period, generatedAt, authors: null, novels: items };
}

/** 榜单缓存：落 cache_entries 表，多实例共享同一份快照（§4.5）。测试推进时钟即可失效。 */
export class LeaderboardCache {
  get(deps: AppDeps, q: LeaderboardQuery): LeaderboardResponse {
    return getCached(deps, `leaderboard:${q.board}:${q.period}`, CACHE_TTL_MS, () => leaderboard(deps, q));
  }
}
