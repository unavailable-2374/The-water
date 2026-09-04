/**
 * 公开身份与关系图：作者主页、作品陈列、关注、屏蔽。
 * 屏蔽的语义见 blocking.ts；积分在 follow 成功时通过 incentive 记账（后续步骤接入）。
 */
import { and, asc, desc, eq, isNull, isNotNull, lt, or, sql } from 'drizzle-orm';
import {
  BADGE_BY_ID,
  levelFor,
  type BadgeId,
  type NovelSummary,
  type Page,
  type UserCard,
  type UserNovelsQuery,
  type UserProfile,
} from '@the-water/shared';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { AppDeps, AuthUser } from '../../context';
import { changes } from '../../db/client';
import { blocks, follows, forks, novels, userBadges, users, type UserRow } from '../../db/schema';
import { decodeCursor, encodeCursor } from '../../lib/cursor';
import { ApiError, notFound, validation } from '../../lib/errors';
import type { ModerationField } from '../../lib/moderation';
import { iso } from '../../lib/time';
import { authorShareUrl } from '../../lib/urls';
import { assertTextAllowed } from '../admin/audit';
import { publicListWhere } from '../browse/service';
import { toNovelSummary } from '../novels/dto';
import { type Viewer } from '../novels/service';
import { hasBlocked, isBlockedEitherWay } from './blocking';
import { awardFollow } from '../incentive/service';

export function toUserCard(u: UserRow): UserCard {
  return {
    id: u.id,
    handle: u.handle,
    displayName: u.displayName,
    bio: u.bio,
    followerCount: u.followerCount,
    points: u.points,
    level: levelFor(u.points),
  };
}

export function findUserRow(deps: AppDeps, id: string): UserRow | undefined {
  return deps.db.select().from(users).where(eq(users.id, id)).get();
}

export function findUserByHandle(deps: AppDeps, handle: string): UserRow | undefined {
  return deps.db.select().from(users).where(eq(users.handle, handle.trim().toLowerCase())).get();
}

/** 作者的公开统计：只统计公开可读的作品。 */
function statsOf(deps: AppDeps, u: UserRow) {
  const agg = deps.db
    .select({
      novelCount: sql<number>`sum(case when ${novels.sourceNovelId} is null then 1 else 0 end)`,
      derivativeCount: sql<number>`sum(case when ${novels.sourceNovelId} is not null then 1 else 0 end)`,
      likeReceived: sql<number>`coalesce(sum(${novels.likeCount}), 0)`,
      viewReceived: sql<number>`coalesce(sum(${novels.viewCount}), 0)`,
    })
    .from(novels)
    .where(and(eq(novels.authorId, u.id), publicListWhere()))
    .get();
  const derived = deps.db
    .select({ c: sql<number>`count(*)` })
    .from(forks)
    .innerJoin(novels, eq(novels.id, forks.sourceNovelId))
    .where(eq(novels.authorId, u.id))
    .get();
  return {
    followingCount: u.followingCount,
    novelCount: agg?.novelCount ?? 0,
    derivativeCount: agg?.derivativeCount ?? 0,
    derivedCount: derived?.c ?? 0,
    likeReceived: agg?.likeReceived ?? 0,
    viewReceived: agg?.viewReceived ?? 0,
  };
}

export function listBadges(deps: AppDeps, userId: string) {
  return deps.db
    .select()
    .from(userBadges)
    .where(eq(userBadges.userId, userId))
    .orderBy(asc(userBadges.awardedAt))
    .all()
    .map((b) => ({ id: b.badge as BadgeId, awardedAt: iso(b.awardedAt) }))
    // 未知徽章（回滚旧版本后残留）直接丢掉，避免整个响应过不了契约校验。
    .filter((b) => !!BADGE_BY_ID[b.id]);
}

export function buildUserProfile(deps: AppDeps, u: UserRow, viewer: Viewer): UserProfile {
  let relation: UserProfile['viewer'] = null;
  if (viewer && viewer.id !== u.id) {
    relation = {
      following: !!deps.db
        .select({ x: sql`1` })
        .from(follows)
        .where(and(eq(follows.followerId, viewer.id), eq(follows.followeeId, u.id)))
        .get(),
      followedBy: !!deps.db
        .select({ x: sql`1` })
        .from(follows)
        .where(and(eq(follows.followerId, u.id), eq(follows.followeeId, viewer.id)))
        .get(),
      blocked: hasBlocked(deps, viewer.id, u.id),
      blockedBy: hasBlocked(deps, u.id, viewer.id),
    };
  } else if (viewer) {
    relation = { following: false, followedBy: false, blocked: false, blockedBy: false };
  }
  return {
    ...toUserCard(u),
    createdAt: iso(u.createdAt),
    stats: statsOf(deps, u),
    badges: listBadges(deps, u.id),
    viewer: relation,
    shareUrl: authorShareUrl(deps.env, u.handle),
  };
}

export function getUserProfile(deps: AppDeps, id: string, viewer: Viewer): UserProfile {
  const u = findUserRow(deps, id);
  if (!u) throw notFound('用户');
  return buildUserProfile(deps, u, viewer);
}

export function getUserProfileByHandle(deps: AppDeps, handle: string, viewer: Viewer): UserProfile {
  const u = findUserByHandle(deps, handle);
  if (!u) throw notFound('用户');
  return buildUserProfile(deps, u, viewer);
}

/** 作者主页的作品陈列。与访客互相屏蔽时返回空页（资料页仍可见，便于解除屏蔽）。 */
export function listUserNovels(deps: AppDeps, authorId: string, viewer: Viewer, q: UserNovelsQuery): Page<NovelSummary> {
  const author = findUserRow(deps, authorId);
  if (!author) throw notFound('用户');
  if (viewer && viewer.id !== authorId && isBlockedEitherWay(deps, viewer.id, authorId)) {
    return { items: [], nextCursor: null };
  }
  const conds = [publicListWhere(), eq(novels.authorId, authorId)];
  if (q.kind === 'original') conds.push(isNull(novels.sourceNovelId));
  if (q.kind === 'derivative') conds.push(isNotNull(novels.sourceNovelId));
  const cursor = decodeCursor(q.cursor);
  if (cursor) {
    conds.push(
      or(
        lt(novels.lastPublishedAt, new Date(cursor.v)),
        and(eq(novels.lastPublishedAt, new Date(cursor.v)), lt(novels.id, cursor.id)),
      )!,
    );
  }
  const rows = deps.db
    .select({ n: novels, author: { id: users.id, displayName: users.displayName, handle: users.handle } })
    .from(novels)
    .innerJoin(users, eq(users.id, novels.authorId))
    .where(and(...conds))
    .orderBy(desc(novels.lastPublishedAt), desc(novels.id))
    .limit(q.limit + 1)
    .all();
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => toNovelSummary(r.n, r.author)),
    nextCursor: rows.length > q.limit && last ? encodeCursor({ v: last.n.lastPublishedAt?.getTime() ?? 0, id: last.n.id }) : null,
  };
}

// ---- 关注 ----

function followerCountOf(deps: AppDeps, userId: string): number {
  return deps.db.select({ c: users.followerCount }).from(users).where(eq(users.id, userId)).get()?.c ?? 0;
}

export function follow(deps: AppDeps, user: AuthUser, targetId: string) {
  if (user.id === targetId) throw validation('不能关注自己');
  const target = findUserRow(deps, targetId);
  if (!target) throw notFound('用户');
  // 关注的守卫与其它互动一致，只是文案更贴切。
  if (isBlockedEitherWay(deps, user.id, targetId)) throw new ApiError('BLOCKED', '你们之间设置了屏蔽，不能互相关注');
  deps.db.transaction((tx) => {
    const res = tx
      .insert(follows)
      .values({ followerId: user.id, followeeId: targetId, createdAt: deps.clock.now() })
      .onConflictDoNothing()
      .run();
    if (changes(res) > 0) {
      tx.update(users).set({ followerCount: sql`${users.followerCount} + 1` }).where(eq(users.id, targetId)).run();
      tx.update(users).set({ followingCount: sql`${users.followingCount} + 1` }).where(eq(users.id, user.id)).run();
      awardFollow(deps, tx, targetId, user.id);
    }
  });
  return { following: true, followerCount: followerCountOf(deps, targetId) };
}

export function unfollow(deps: AppDeps, user: AuthUser, targetId: string) {
  if (user.id === targetId) throw validation('不能关注自己');
  if (!findUserRow(deps, targetId)) throw notFound('用户');
  deps.db.transaction((tx) => {
    const res = tx.delete(follows).where(and(eq(follows.followerId, user.id), eq(follows.followeeId, targetId))).run();
    if (changes(res) > 0) {
      tx.update(users).set({ followerCount: sql`max(${users.followerCount} - 1, 0)` }).where(eq(users.id, targetId)).run();
      tx.update(users).set({ followingCount: sql`max(${users.followingCount} - 1, 0)` }).where(eq(users.id, user.id)).run();
    }
  });
  return { following: false, followerCount: followerCountOf(deps, targetId) };
}

// ---- 屏蔽 ----

/** 屏蔽会同时解除双方的关注关系（并修正两侧计数）。 */
export function block(deps: AppDeps, user: AuthUser, targetId: string) {
  if (user.id === targetId) throw validation('不能屏蔽自己');
  if (!findUserRow(deps, targetId)) throw notFound('用户');
  deps.db.transaction((tx) => {
    tx.insert(blocks).values({ blockerId: user.id, blockedId: targetId, createdAt: deps.clock.now() }).onConflictDoNothing().run();
    const mine = tx.delete(follows).where(and(eq(follows.followerId, user.id), eq(follows.followeeId, targetId))).run();
    if (changes(mine) > 0) {
      tx.update(users).set({ followerCount: sql`max(${users.followerCount} - 1, 0)` }).where(eq(users.id, targetId)).run();
      tx.update(users).set({ followingCount: sql`max(${users.followingCount} - 1, 0)` }).where(eq(users.id, user.id)).run();
    }
    const theirs = tx.delete(follows).where(and(eq(follows.followerId, targetId), eq(follows.followeeId, user.id))).run();
    if (changes(theirs) > 0) {
      tx.update(users).set({ followerCount: sql`max(${users.followerCount} - 1, 0)` }).where(eq(users.id, user.id)).run();
      tx.update(users).set({ followingCount: sql`max(${users.followingCount} - 1, 0)` }).where(eq(users.id, targetId)).run();
    }
  });
  return { blocked: true };
}

/** 解除屏蔽不会恢复之前的关注关系。 */
export function unblock(deps: AppDeps, user: AuthUser, targetId: string) {
  if (!findUserRow(deps, targetId)) throw notFound('用户');
  deps.db.delete(blocks).where(and(eq(blocks.blockerId, user.id), eq(blocks.blockedId, targetId))).run();
  return { blocked: false };
}

// ---- 我的关系列表 ----

type RelationList = 'following' | 'followers' | 'blocks';

interface RelationRow {
  createdAt: Date;
  u: UserRow;
}

export function listRelations(
  deps: AppDeps,
  user: AuthUser,
  which: RelationList,
  cursorRaw: string | undefined,
  limit: number,
): Page<UserCard> {
  const cursor = decodeCursor(cursorRaw);
  const keyset = (createdAtCol: SQLiteColumn, userCol: SQLiteColumn) =>
    cursor
      ? or(lt(createdAtCol, new Date(cursor.v)), and(eq(createdAtCol, new Date(cursor.v)), lt(userCol, cursor.id)))
      : undefined;

  let rows: RelationRow[];
  if (which === 'blocks') {
    rows = deps.db
      .select({ createdAt: blocks.createdAt, u: users })
      .from(blocks)
      .innerJoin(users, eq(users.id, blocks.blockedId))
      .where(and(eq(blocks.blockerId, user.id), keyset(blocks.createdAt, blocks.blockedId)))
      .orderBy(desc(blocks.createdAt), desc(blocks.blockedId))
      .limit(limit + 1)
      .all();
  } else if (which === 'following') {
    rows = deps.db
      .select({ createdAt: follows.createdAt, u: users })
      .from(follows)
      .innerJoin(users, eq(users.id, follows.followeeId))
      .where(and(eq(follows.followerId, user.id), keyset(follows.createdAt, follows.followeeId)))
      .orderBy(desc(follows.createdAt), desc(follows.followeeId))
      .limit(limit + 1)
      .all();
  } else {
    rows = deps.db
      .select({ createdAt: follows.createdAt, u: users })
      .from(follows)
      .innerJoin(users, eq(users.id, follows.followerId))
      .where(and(eq(follows.followeeId, user.id), keyset(follows.createdAt, follows.followerId)))
      .orderBy(desc(follows.createdAt), desc(follows.followerId))
      .limit(limit + 1)
      .all();
  }

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => toUserCard(r.u)),
    nextCursor: rows.length > limit && last ? encodeCursor({ v: last.createdAt.getTime(), id: last.u.id }) : null,
  };
}

// ---- 个人资料审核（P0-2）----

/**
 * 昵称 / 简介 / handle 的准入检查。未过审直接抛 CONTENT_REJECTED，并留一条 auto_reject 审计记录。
 *
 * 供 auth/service.ts 的 updateProfile 调用（那个文件不归本模块所有）：
 *   await moderateProfileFields(deps, patch, user.id);
 */
export async function moderateProfileFields(
  deps: AppDeps,
  patch: { displayName?: string; handle?: string; bio?: string | null },
  userId?: string,
): Promise<void> {
  const fields: ModerationField[] = [];
  if (patch.displayName !== undefined) fields.push({ label: '昵称', text: patch.displayName });
  if (patch.handle !== undefined) fields.push({ label: '用户名', text: patch.handle });
  if (patch.bio !== undefined && patch.bio !== null) fields.push({ label: '简介', text: patch.bio });
  await assertTextAllowed(deps, fields, { type: 'user', id: userId ?? 'unknown', meta: { kind: 'profile' } });
}
