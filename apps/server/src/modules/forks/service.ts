import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { Fork, ForkWithRefsSchema, Page } from '@the-water/shared';
import type { z } from 'zod';
import type { AppDeps, AuthUser } from '../../context';
import { forks, novels, novelVersions, type ForkRow } from '../../db/schema';
import { ApiError, notFound } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { decodeCursor, encodeCursor } from '../../lib/cursor';
import { iso } from '../../lib/time';
import { isPubliclyViewable, loadViewableNovel, novelRefFor, type Viewer } from '../novels/service';
import { assertNotBlocked } from '../users/blocking';
import { awardFork } from '../incentive/service';
import { findVersion } from '../versions/service';

export type ForkWithRefs = z.infer<typeof ForkWithRefsSchema>;

function versionNumberOf(deps: AppDeps, versionId: string): number {
  const v = deps.db.select({ n: novelVersions.versionNumber }).from(novelVersions).where(eq(novelVersions.id, versionId)).get();
  return v?.n ?? 0;
}

export function toFork(deps: AppDeps, f: ForkRow): Fork {
  return {
    id: f.id,
    sourceNovelId: f.sourceNovelId,
    sourceVersionId: f.sourceVersionId,
    sourceVersionNumber: versionNumberOf(deps, f.sourceVersionId),
    derivativeNovelId: f.derivativeNovelId,
    createdAt: iso(f.createdAt),
  };
}

export function toForkWithRefs(deps: AppDeps, f: ForkRow, viewer: Viewer): ForkWithRefs {
  return {
    ...toFork(deps, f),
    source: novelRefFor(deps, f.sourceNovelId, viewer),
    derivative: f.derivativeNovelId ? novelRefFor(deps, f.derivativeNovelId, viewer) : null,
  };
}

/**
 * 创建 fork 记录（授权证明）。要求：源可公开阅读、允许二创、目标版本已提交。
 * 作者关闭二创不影响已存在的 fork。
 */
export function createFork(deps: AppDeps, user: AuthUser, novelId: string, versionId: string | undefined): ForkWithRefs {
  const novel = loadViewableNovel(deps, novelId, user);
  if (!isPubliclyViewable(novel)) throw notFound('小说');
  if (!novel.allowDerivatives) throw new ApiError('DERIVATIVES_NOT_ALLOWED', '作者未开放二创');
  assertNotBlocked(deps, user.id, novel.authorId);
  const vid = versionId ?? novel.currentVersionId;
  if (!vid) throw notFound('版本');
  const v = findVersion(deps, novelId, vid);
  if (!v || v.status !== 'committed') throw notFound('版本');

  const row: typeof forks.$inferInsert = {
    id: newId(),
    userId: user.id,
    sourceNovelId: novelId,
    sourceVersionId: v.id,
    derivativeNovelId: null,
    createdAt: deps.clock.now(),
  };
  deps.db.transaction((tx) => {
    tx.insert(forks).values(row).run();
    tx.update(novels)
      .set({ forkCount: sql`${novels.forkCount} + 1` })
      .where(eq(novels.id, novelId))
      .run();
    awardFork(deps, tx, novel, user.id);
  });
  const inserted = deps.db.select().from(forks).where(eq(forks.id, row.id!)).get()!;
  return toForkWithRefs(deps, inserted, user);
}

export function findFork(deps: AppDeps, forkId: string): ForkRow | undefined {
  return deps.db.select().from(forks).where(eq(forks.id, forkId)).get();
}

export function listMyForks(deps: AppDeps, user: AuthUser, cursorRaw: string | undefined, limit: number): Page<ForkWithRefs> {
  const cursor = decodeCursor(cursorRaw);
  const base = eq(forks.userId, user.id);
  const where = cursor
    ? and(base, or(lt(forks.createdAt, new Date(cursor.v)), and(eq(forks.createdAt, new Date(cursor.v)), lt(forks.id, cursor.id))))
    : base;
  const rows = deps.db.select().from(forks).where(where).orderBy(desc(forks.createdAt), desc(forks.id)).limit(limit + 1).all();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((f) => toForkWithRefs(deps, f, user)),
    nextCursor: rows.length > limit && last ? encodeCursor({ v: last.createdAt.getTime(), id: last.id }) : null,
  };
}
