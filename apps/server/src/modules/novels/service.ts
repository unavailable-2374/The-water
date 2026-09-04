import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import {
  LIMITS,
  SHARE_ALIKE_LICENSES,
  type CreateNovelRequest,
  type License,
  type NovelDetail,
  type NovelRef,
  type NovelSummary,
  type Page,
  type UpdateNovelRequest,
} from '@the-water/shared';
import type { AppDeps, AuthUser } from '../../context';
import { follows, forks, likes, novels, novelVersions, users, type NovelRow } from '../../db/schema';
import { ApiError, conflict, forbidden, notFound, validation } from '../../lib/errors';
import type { ModerationField } from '../../lib/moderation';
import { newId } from '../../lib/ids';
import { decodeCursor, encodeCursor } from '../../lib/cursor';
import { novelShareUrl } from '../../lib/urls';
import { assertTextAllowed } from '../admin/audit';
import { recordActivity } from '../feed/service';
import { awardCompleted } from '../incentive/service';
import { hasBlocked } from '../users/blocking';
import { toNovelDetail, toNovelRef, toNovelSummary, unavailableRef, type AuthorParts } from './dto';

export type Viewer = AuthUser | null;

/** 公众可读：已发布（public/unlisted）、审核通过、未删除。 */
export function isPubliclyViewable(n: NovelRow): boolean {
  return n.deletedAt === null && n.visibility !== 'unpublished' && n.moderationStatus === 'ok';
}

export function isOwnerOrAdmin(n: NovelRow, viewer: Viewer): boolean {
  return !!viewer && (viewer.id === n.authorId || viewer.role === 'admin');
}

/** 作者与管理员可看任何未删除小说（管理员可看已 removed）；其他人仅限公开可读。 */
export function canView(n: NovelRow, viewer: Viewer): boolean {
  if (n.deletedAt !== null) return viewer?.role === 'admin';
  if (isOwnerOrAdmin(n, viewer)) return true;
  return isPubliclyViewable(n);
}

export function findNovelRow(deps: AppDeps, id: string): NovelRow | undefined {
  return deps.db.select().from(novels).where(eq(novels.id, id)).get();
}

export function loadViewableNovel(deps: AppDeps, id: string, viewer: Viewer): NovelRow {
  const n = findNovelRow(deps, id);
  if (!n || !canView(n, viewer)) throw notFound('小说');
  return n;
}

export function loadOwnedNovel(deps: AppDeps, id: string, user: AuthUser): NovelRow {
  const n = findNovelRow(deps, id);
  if (!n || n.deletedAt !== null) throw notFound('小说');
  if (!isOwnerOrAdmin(n, user)) throw forbidden('只有作者可以操作此小说');
  return n;
}

export function authorOf(deps: AppDeps, authorId: string): AuthorParts {
  const u = deps.db
    .select({ id: users.id, displayName: users.displayName, handle: users.handle })
    .from(users)
    .where(eq(users.id, authorId))
    .get();
  return u ?? { id: authorId, displayName: '（未知作者）', handle: '' };
}

/** 供谱系与 source 引用使用：不可见即为“已下架”占位。 */
export function novelRefFor(deps: AppDeps, id: string, viewer: Viewer): NovelRef {
  const n = findNovelRow(deps, id);
  if (!n || !canView(n, viewer)) return unavailableRef(id);
  return toNovelRef(n, authorOf(deps, n.authorId));
}

export function buildNovelDetail(deps: AppDeps, n: NovelRow, viewer: Viewer): NovelDetail {
  const author = authorOf(deps, n.authorId);
  const currentVersion = n.currentVersionId
    ? (deps.db.select().from(novelVersions).where(eq(novelVersions.id, n.currentVersionId)).get() ?? null)
    : null;
  let source: { ref: NovelRef; versionId: string; versionNumber: number } | null = null;
  if (n.sourceNovelId && n.sourceVersionId) {
    const sv = deps.db
      .select({ versionNumber: novelVersions.versionNumber })
      .from(novelVersions)
      .where(eq(novelVersions.id, n.sourceVersionId))
      .get();
    source = {
      ref: novelRefFor(deps, n.sourceNovelId, viewer),
      versionId: n.sourceVersionId,
      versionNumber: sv?.versionNumber ?? 0,
    };
  }
  let viewerState: NonNullable<Parameters<typeof toNovelDetail>[1]['viewer']> | null = null;
  if (viewer) {
    const liked = !!deps.db
      .select({ x: sql`1` })
      .from(likes)
      .where(and(eq(likes.userId, viewer.id), eq(likes.novelId, n.id)))
      .get();
    const forked = !!deps.db
      .select({ x: sql`1` })
      .from(forks)
      .where(and(eq(forks.userId, viewer.id), eq(forks.sourceNovelId, n.id)))
      .get();
    const followingAuthor =
      viewer.id !== n.authorId &&
      !!deps.db
        .select({ x: sql`1` })
        .from(follows)
        .where(and(eq(follows.followerId, viewer.id), eq(follows.followeeId, n.authorId)))
        .get();
    const blockedAuthor = viewer.id !== n.authorId && hasBlocked(deps, viewer.id, n.authorId);
    viewerState = { liked, forked, followingAuthor, blockedAuthor };
  }
  return toNovelDetail(n, {
    author,
    currentVersion,
    source,
    viewer: viewerState,
    shareUrl: isPubliclyViewable(n) ? novelShareUrl(deps.env, n.id) : null,
  });
}

export function getNovelDetail(deps: AppDeps, id: string, viewer: Viewer): NovelDetail {
  return buildNovelDetail(deps, loadViewableNovel(deps, id, viewer), viewer);
}

/** all-rights-reserved 强制关闭二创。 */
export function effectiveAllowDerivatives(license: License, requested: boolean): boolean {
  return license === 'all-rights-reserved' ? false : requested;
}

/** SA 许可的二创必须沿用同一许可。 */
export function assertLicenseInheritance(sourceLicense: License, derivativeLicense: License): void {
  if (SHARE_ALIKE_LICENSES.includes(sourceLicense) && derivativeLicense !== sourceLicense) {
    throw validation(`原作许可为 ${sourceLicense}，二创必须使用相同许可`, {
      requiredLicense: sourceLicense,
    });
  }
}

export async function createNovel(deps: AppDeps, user: AuthUser, req: CreateNovelRequest): Promise<NovelDetail> {
  const now = deps.clock.now();
  // P0-2：元数据也要过审，否则“干净内容过审后改标题”就是现成的绕过路径。
  await assertTextAllowed(deps, metaFields(req), { type: 'user', id: user.id, meta: { kind: 'novel_create' } });
  const count = deps.db
    .select({ c: sql<number>`count(*)` })
    .from(novels)
    .where(and(eq(novels.authorId, user.id), isNull(novels.deletedAt)))
    .get();
  if ((count?.c ?? 0) >= LIMITS.MAX_NOVELS_PER_USER) {
    throw conflict(`每位作者最多 ${LIMITS.MAX_NOVELS_PER_USER} 本小说`);
  }

  const id = newId();
  let lineage = { sourceNovelId: null as string | null, sourceVersionId: null as string | null, rootNovelId: id, depth: 0, forkId: null as string | null };

  if (req.source) {
    const fork = deps.db.select().from(forks).where(eq(forks.id, req.source.forkId)).get();
    if (!fork || fork.userId !== user.id) throw notFound('fork 记录');
    if (fork.derivativeNovelId) throw conflict('该 fork 已发布过一本二创', { derivativeNovelId: fork.derivativeNovelId });
    const src = findNovelRow(deps, fork.sourceNovelId);
    if (!src) throw notFound('原作');
    assertLicenseInheritance(src.license, req.license);
    lineage = {
      sourceNovelId: src.id,
      sourceVersionId: fork.sourceVersionId,
      rootNovelId: src.rootNovelId,
      depth: src.depth + 1,
      forkId: fork.id,
    };
  }

  const row: typeof novels.$inferInsert = {
    id,
    authorId: user.id,
    title: req.title,
    summary: req.summary,
    tags: req.tags,
    language: req.language,
    writingStatus: req.writingStatus,
    license: req.license,
    allowDerivatives: effectiveAllowDerivatives(req.license, req.allowDerivatives),
    visibility: 'unpublished',
    publishVisibility: req.visibility,
    moderationStatus: 'ok',
    ...lineage,
    createdAt: now,
    updatedAt: now,
  };
  deps.db.transaction((tx) => {
    tx.insert(novels).values(row).run();
    if (lineage.forkId) {
      tx.update(forks).set({ derivativeNovelId: id }).where(eq(forks.id, lineage.forkId)).run();
    }
  });
  return buildNovelDetail(deps, findNovelRow(deps, id)!, user);
}

/** 参与审核的元数据字段。 */
function metaFields(patch: { title?: string; summary?: string; tags?: string[] }): ModerationField[] {
  const fields: ModerationField[] = [];
  if (patch.title !== undefined) fields.push({ label: '标题', text: patch.title });
  if (patch.summary !== undefined) fields.push({ label: '简介', text: patch.summary });
  if (patch.tags !== undefined) fields.push({ label: '标签', text: patch.tags.join(' ') });
  return fields;
}

export async function updateNovel(deps: AppDeps, user: AuthUser, id: string, patch: UpdateNovelRequest): Promise<NovelDetail> {
  const n = loadOwnedNovel(deps, id, user);
  await assertTextAllowed(deps, metaFields(patch), { type: 'novel', id, meta: { kind: 'novel_meta', authorId: n.authorId } });
  const license = patch.license ?? n.license;
  if (n.sourceNovelId && patch.license) {
    const src = findNovelRow(deps, n.sourceNovelId);
    if (src) assertLicenseInheritance(src.license, license);
  }
  const allowDerivatives = effectiveAllowDerivatives(license, patch.allowDerivatives ?? n.allowDerivatives);
  const set: Partial<typeof novels.$inferInsert> = { updatedAt: deps.clock.now(), license, allowDerivatives };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.summary !== undefined) set.summary = patch.summary;
  if (patch.tags !== undefined) set.tags = patch.tags;
  if (patch.writingStatus !== undefined) set.writingStatus = patch.writingStatus;
  if (patch.visibility !== undefined) {
    set.publishVisibility = patch.visibility;
    if (n.visibility !== 'unpublished') set.visibility = patch.visibility;
  }
  const completing = patch.writingStatus === 'completed' && n.writingStatus !== 'completed' && !!n.currentVersionId;
  deps.db.transaction((tx) => {
    tx.update(novels).set(set).where(eq(novels.id, id)).run();
    // 「写完了这个故事」只在第一次切到完结时记一条动态。
    if (completing) {
      recordActivity(deps, tx, { actorId: n.authorId, kind: 'novel_completed', novelId: id });
      awardCompleted(deps, tx, n);
    }
  });
  return buildNovelDetail(deps, findNovelRow(deps, id)!, user);
}

/** 软删除：对所有人不可见，谱系中显示为“已下架”；blob 内容寻址不受影响。 */
export function deleteNovel(deps: AppDeps, user: AuthUser, id: string): void {
  loadOwnedNovel(deps, id, user);
  const now = deps.clock.now();
  deps.db.update(novels).set({ deletedAt: now, updatedAt: now, visibility: 'unpublished' }).where(eq(novels.id, id)).run();
}

export function listMyNovels(deps: AppDeps, user: AuthUser, cursorRaw: string | undefined, limit: number): Page<NovelSummary> {
  const cursor = decodeCursor(cursorRaw);
  const base = and(eq(novels.authorId, user.id), isNull(novels.deletedAt));
  const where = cursor
    ? and(
        base,
        or(
          lt(novels.updatedAt, new Date(cursor.v)),
          and(eq(novels.updatedAt, new Date(cursor.v)), lt(novels.id, cursor.id)),
        ),
      )
    : base;
  const rows = deps.db
    .select({ n: novels, author: { id: users.id, displayName: users.displayName, handle: users.handle } })
    .from(novels)
    .innerJoin(users, eq(users.id, novels.authorId))
    .where(where)
    .orderBy(desc(novels.updatedAt), desc(novels.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => toNovelSummary(r.n, r.author)),
    nextCursor: rows.length > limit && last ? encodeCursor({ v: last.n.updatedAt.getTime(), id: last.n.id }) : null,
  };
}

export { ApiError };
