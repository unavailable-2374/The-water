/**
 * 动态流：发布/更新/完结时写一行 activities，读取时按关注关系扇入。
 * 原创与二创的区别体现在 item.novel.isDerivative 与 source 上，不占用 kind。
 */
import { and, desc, eq, inArray, lt, or, type SQL } from 'drizzle-orm';
import type { ActivityKind, FeedItem, FeedQuery, Page } from '@the-water/shared';
import type { AppDeps } from '../../context';
import { activities, follows, novels, novelVersions, users, type ActivityRow } from '../../db/schema';
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

export function listFeed(deps: AppDeps, viewer: Viewer, q: FeedQuery): Page<FeedItem> {
  const conds: SQL[] = [publicListWhere()];
  if (q.scope === 'following') {
    if (!viewer) throw unauthorized('登录后才能看关注的作者');
    const followees = deps.db.select({ id: follows.followeeId }).from(follows).where(eq(follows.followerId, viewer.id));
    conds.push(inArray(activities.actorId, followees));
  }
  if (q.actorId) conds.push(eq(activities.actorId, q.actorId));
  if (viewer) conds.push(notBlockedEitherWay(deps, viewer.id, activities.actorId));

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

  return {
    items: page.map((r) => toFeedItem(deps, r.a, r.n, r.author, versions.get(r.a.versionId ?? '') ?? null, viewer)),
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
): FeedItem {
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
