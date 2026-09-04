/**
 * 动态流：发布/更新/完结时写一行 activities，读取时按关注关系扇入。
 * 原创与二创的区别体现在 item.novel.isDerivative 与 source 上，不占用 kind。
 */
import { and, desc, eq, gt, gte, inArray, lt, notExists, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { ActivityKind, FoldedFeedItem, FoldedFeedQuery, Page } from '@the-water/shared';
import type { AppDeps } from '../../context';
import { activities, follows, novels, novelVersions, readingProgress, users, type ActivityRow } from '../../db/schema';
import { decodeCursor, encodeCursor } from '../../lib/cursor';
import { unauthorized } from '../../lib/errors';
import { iso } from '../../lib/time';
import { newId } from '../../lib/ids';
import { publicListWhere } from '../browse/service';
import { toAuthorCard, toNovelSummary } from '../novels/dto';
import { novelRefFor, type Viewer } from '../novels/service';
import { notBlockedEitherWay } from '../users/blocking';

type Executor = Pick<AppDeps['db'], 'select' | 'insert' | 'update' | 'delete'>;

export interface ActivityInput {
  actorId: string;
  kind: ActivityKind;
  novelId: string;
  versionId?: string | null;
}

export function activityDedupeKey(a: ActivityInput): string {
  return `${a.kind}:${a.novelId}:${a.versionId ?? '-'}`;
}

/** 幂等写入一条动态（同一事件重复触发只记一次）。在调用方的事务里执行。 */
export function recordActivity(deps: AppDeps, ex: Executor, a: ActivityInput): void {
  ex.insert(activities)
    .values({
      id: newId(),
      actorId: a.actorId,
      kind: a.kind,
      novelId: a.novelId,
      versionId: a.versionId ?? null,
      dedupeKey: activityDedupeKey(a),
      createdAt: deps.clock.now(),
    })
    .onConflictDoNothing()
    .run();
}

/**
 * 动态流（§3.4 折叠 + 已读态）。
 *
 * 折叠：同一作者的同一本书只出一条，取该组最新的一条动态作为代表，
 * `collapsedCount` 是被折叠进来的动态总数（连发 10 个版本 = 1 条，collapsedCount = 10）。
 * 实现上用 NOT EXISTS「没有更新的同组动态」把非代表行直接排除在 SQL 之外，
 * 于是 (createdAt, id) 这套游标对折叠后的结果依然成立，不需要在内存里凑页。
 *
 * 已读态：登录用户在这条动态之后更新过该作品的云端阅读进度，就算已读。
 * 这样不必再为「动态已读」单独存一张表，语义也更实在 —— 读过才算读过。
 */
export function listFeed(deps: AppDeps, viewer: Viewer, q: FoldedFeedQuery): Page<FoldedFeedItem> {
  const conds: SQL[] = [publicListWhere()];
  if (q.scope === 'following') {
    if (!viewer) throw unauthorized('登录后才能看关注的作者');
    const followees = deps.db.select({ id: follows.followeeId }).from(follows).where(eq(follows.followerId, viewer.id));
    conds.push(inArray(activities.actorId, followees));
  }
  if (q.actorId) conds.push(eq(activities.actorId, q.actorId));
  if (viewer) conds.push(notBlockedEitherWay(deps, viewer.id, activities.actorId));

  if (q.collapse) {
    const newer = alias(activities, 'newer_activity');
    conds.push(
      notExists(
        deps.db
          .select({ one: sql`1` })
          .from(newer)
          .where(
            and(
              eq(newer.actorId, activities.actorId),
              eq(newer.novelId, activities.novelId),
              or(
                gt(newer.createdAt, activities.createdAt),
                and(eq(newer.createdAt, activities.createdAt), gt(newer.id, activities.id)),
              ),
            ),
          ),
      ),
    );
  }
  if (q.unreadOnly && viewer) {
    // 未读 = 没有「更新时间不早于这条动态」的阅读进度。
    conds.push(
      notExists(
        deps.db
          .select({ one: sql`1` })
          .from(readingProgress)
          .where(
            and(
              eq(readingProgress.userId, viewer.id),
              eq(readingProgress.novelId, activities.novelId),
              gte(readingProgress.updatedAt, activities.createdAt),
            ),
          ),
      ),
    );
  }

  const cursor = decodeCursor(q.cursor);
  if (cursor) {
    conds.push(
      or(
        lt(activities.createdAt, new Date(cursor.v)),
        and(eq(activities.createdAt, new Date(cursor.v)), lt(activities.id, cursor.id)),
      )!,
    );
  }

  const rows = deps.db
    .select({
      a: activities,
      n: novels,
      author: { id: users.id, displayName: users.displayName, handle: users.handle },
    })
    .from(activities)
    .innerJoin(novels, eq(novels.id, activities.novelId))
    .innerJoin(users, eq(users.id, activities.actorId))
    .where(and(...conds))
    .orderBy(desc(activities.createdAt), desc(activities.id))
    .limit(q.limit + 1)
    .all();

  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];

  // 版本信息一次取回，避免每条动态一次查询。
  const versionIds = page.map((r) => r.a.versionId).filter((v): v is string => !!v);
  const versions = versionIds.length
    ? new Map(
        deps.db
          .select({ id: novelVersions.id, versionNumber: novelVersions.versionNumber, changeNote: novelVersions.changeNote })
          .from(novelVersions)
          .where(inArray(novelVersions.id, versionIds))
          .all()
          .map((v) => [v.id, v]),
      )
    : new Map<string, { id: string; versionNumber: number; changeNote: string | null }>();

  const novelIds = page.map((r) => r.n.id);

  // 折叠计数：一次分组查询拿回本页每个 (作者, 作品) 组的动态总数。
  const counts = new Map<string, number>();
  if (q.collapse && novelIds.length) {
    for (const row of deps.db
      .select({ actorId: activities.actorId, novelId: activities.novelId, c: sql<number>`count(*)` })
      .from(activities)
      .where(inArray(activities.novelId, novelIds))
      .groupBy(activities.actorId, activities.novelId)
      .all()) {
      counts.set(`${row.actorId}:${row.novelId}`, row.c);
    }
  }

  // 已读态：一次取回本页作品的阅读进度时间。
  const readAt = new Map<string, Date>();
  if (viewer && novelIds.length) {
    for (const row of deps.db
      .select({ novelId: readingProgress.novelId, updatedAt: readingProgress.updatedAt })
      .from(readingProgress)
      .where(and(eq(readingProgress.userId, viewer.id), inArray(readingProgress.novelId, novelIds)))
      .all()) {
      readAt.set(row.novelId, row.updatedAt);
    }
  }

  return {
    items: page.map((r) => {
      const progressAt = readAt.get(r.n.id);
      return {
        ...toFeedItem(deps, r.a, r.n, r.author, versions.get(r.a.versionId ?? '') ?? null, viewer),
        collapsedCount: q.collapse ? (counts.get(`${r.a.actorId}:${r.n.id}`) ?? 1) : 1,
        read: !!progressAt && progressAt.getTime() >= r.a.createdAt.getTime(),
      };
    }),
    nextCursor: rows.length > q.limit && last ? encodeCursor({ v: last.a.createdAt.getTime(), id: last.a.id }) : null,
  };
}

function toFeedItem(
  deps: AppDeps,
  a: ActivityRow,
  n: typeof novels.$inferSelect,
  author: { id: string; displayName: string; handle: string },
  version: { id: string; versionNumber: number; changeNote: string | null } | null,
  viewer: Viewer,
): Omit<FoldedFeedItem, 'collapsedCount' | 'read'> {
  return {
    id: a.id,
    kind: a.kind,
    actor: toAuthorCard(author),
    novel: toNovelSummary(n, author),
    source: n.sourceNovelId ? novelRefFor(deps, n.sourceNovelId, viewer) : null,
    version,
    createdAt: iso(a.createdAt),
  };
}
