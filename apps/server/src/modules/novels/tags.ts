/**
 * 标签目录（§3.4）。
 *
 * 真相来源仍然是 `novels.tags`（作者写的原始文本）；`novel_tags` 是它的归一化投影，
 * `tags` 是按 slug 聚合的目录。三者由 `syncNovelTags()` 在每次小说写入后重建，
 * 该函数幂等，重复调用不会算错计数。
 *
 * 计数口径与迁移 `0003_lumpy_mister_fear.sql` 的回填完全一致：
 * public + 审核通过 + 未删除。unlisted 与未发布的作品有 `novel_tags` 映射但不计数。
 */
import { and, asc, desc, eq, exists, gt, inArray, isNull, like, lt, or, sql, type SQL } from 'drizzle-orm';
import { normalizeTagSlug, type Page, type TagDirectoryQuery, type TagSummary } from '@the-water/shared';
import type { AppDeps } from '../../context';
import { novels, novelTags, tags, type TagRow } from '../../db/schema';
import { decodeCursor, encodeCursor } from '../../lib/cursor';

type Executor = Pick<AppDeps['db'], 'select' | 'insert' | 'update' | 'delete'>;

/**
 * 标签归一化：`trim` 后把 A–Z 转小写，等价于迁移里的 `lower(trim(...))`。
 * 注意不要换成 JS 的 `toLowerCase()`：它会把 `Ä`→`ä` 之类的非 ASCII 字符也降级，
 * 而 SQLite 的 `lower()` 不会，两边就会算出不同的 slug。
 */
export function normalizeTag(raw: string): string {
  return normalizeTagSlug(raw);
}

export interface TagPair {
  slug: string;
  /** 展示用的原始写法。 */
  label: string;
}

/** 归一化一组标签并按 slug 去重（保留首次出现的原始写法）。 */
export function normalizeTags(list: readonly string[]): TagPair[] {
  const out: TagPair[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const slug = normalizeTag(raw);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, label: raw.trim() || slug });
  }
  return out;
}

/** 一个 slug 当前的公开作品数。 */
function countPublicNovels(ex: Executor, slug: string): number {
  const row = ex
    .select({ c: sql<number>`count(*)` })
    .from(novelTags)
    .innerJoin(novels, eq(novels.id, novelTags.novelId))
    .where(
      and(
        eq(novelTags.slug, slug),
        eq(novels.visibility, 'public'),
        eq(novels.moderationStatus, 'ok'),
        isNull(novels.deletedAt),
      ),
    )
    .get();
  return row?.c ?? 0;
}

/**
 * 重算若干 slug 的计数。label 非空时顺带刷新展示写法；计数归零的 slug 直接删行，
 * 目录里就不会留下一堆 0 计数的空标签。
 */
function recountTags(deps: AppDeps, ex: Executor, affected: Map<string, string | null>): void {
  const now = deps.clock.now();
  for (const [slug, label] of affected) {
    const c = countPublicNovels(ex, slug);
    if (c === 0) {
      ex.delete(tags).where(eq(tags.slug, slug)).run();
      continue;
    }
    ex.insert(tags)
      .values({ slug, label: label ?? slug, novelCount: c, updatedAt: now })
      .onConflictDoUpdate({
        target: tags.slug,
        set: label ? { label, novelCount: c, updatedAt: now } : { novelCount: c, updatedAt: now },
      })
      .run();
  }
}

/**
 * 把一本小说的标签同步到 `novel_tags` 与 `tags`。
 * 在调用方的事务里执行；小说行必须已经写完（本函数会重新读一遍）。
 *
 * 需要调用它的时机：创建 / 改标签 / 改可见性 / 软删除 / 提交版本（首次转公开）/ 审核状态变化。
 */
export function syncNovelTags(deps: AppDeps, ex: Executor, novelId: string): void {
  const row = ex.select({ tags: novels.tags }).from(novels).where(eq(novels.id, novelId)).get();
  const desired = row ? normalizeTags(row.tags) : [];
  const desiredSlugs = new Set(desired.map((d) => d.slug));

  const existing = ex
    .select({ slug: novelTags.slug })
    .from(novelTags)
    .where(eq(novelTags.novelId, novelId))
    .all()
    .map((r) => r.slug);
  const existingSet = new Set(existing);

  const toDelete = existing.filter((s) => !desiredSlugs.has(s));
  const toInsert = desired.filter((d) => !existingSet.has(d.slug));
  if (toDelete.length) {
    ex.delete(novelTags).where(and(eq(novelTags.novelId, novelId), inArray(novelTags.slug, toDelete))).run();
  }
  if (toInsert.length) {
    ex.insert(novelTags)
      .values(toInsert.map((d) => ({ novelId, slug: d.slug })))
      .onConflictDoNothing()
      .run();
  }

  // 受影响的 slug = 被摘掉的（只重算计数）+ 当前全部（顺带刷新 label）。
  const affected = new Map<string, string | null>();
  for (const s of toDelete) affected.set(s, null);
  for (const d of desired) affected.set(d.slug, d.label);
  recountTags(deps, ex, affected);
}

/**
 * 「这本小说带某个标签」的筛选条件。传进来的可以是 slug，也可以是作者写的原始写法 ——
 * 归一化是幂等的（`normalizeTag(slug) === slug`），两种都能命中同一批作品。
 *
 * 网页层的 `/browse?tag=` 与 API 的 `GET /novels?tag=` 都应该用这一个条件，
 * 不要再走 `db/search.ts` 的 `hasTag()`（那个直接比 `novels.tags` 里的原始 JSON 值，
 * 大小写和首尾空格不同就搜不到）。链接参数请一律用 slug：它稳定、可预测、可做规范化 URL。
 */
export function hasNormalizedTag(deps: AppDeps, tag: string): SQL {
  const slug = normalizeTag(tag);
  return exists(
    deps.db
      .select({ one: sql`1` })
      .from(novelTags)
      .where(and(eq(novelTags.novelId, novels.id), eq(novelTags.slug, slug))),
  );
}

function toTagSummary(t: TagRow): TagSummary {
  return { slug: t.slug, label: t.label, novelCount: t.novelCount };
}

/** 目录里的模糊匹配：不支持通配符，直接把 LIKE 的元字符去掉，省得再引入方言转义。 */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, '')}%`;
}

/**
 * 标签目录。两种排序的游标都稳定：
 * - popular：(novelCount, slug) 倒序。计数会变，但 slug 是唯一且不变的次键，同计数内不会漂移；
 * - name：slug 升序，完全不依赖可变字段。
 */
export function listTags(deps: AppDeps, q: TagDirectoryQuery): Page<TagSummary> {
  const cursor = decodeCursor(q.cursor);
  const conds = [];
  if (q.q) conds.push(like(tags.slug, likePattern(normalizeTag(q.q))));

  let rows: TagRow[];
  if (q.sort === 'name') {
    if (cursor) conds.push(gt(tags.slug, cursor.id));
    rows = deps.db
      .select()
      .from(tags)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(tags.slug))
      .limit(q.limit + 1)
      .all();
  } else {
    if (cursor) {
      conds.push(
        or(lt(tags.novelCount, cursor.v), and(eq(tags.novelCount, cursor.v), lt(tags.slug, cursor.id)))!,
      );
    }
    rows = deps.db
      .select()
      .from(tags)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(tags.novelCount), desc(tags.slug))
      .limit(q.limit + 1)
      .all();
  }

  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toTagSummary),
    nextCursor: rows.length > q.limit && last ? encodeCursor({ v: last.novelCount, id: last.slug }) : null,
  };
}

/** 热门标签：按作品数取前 N 个。 */
export function popularTags(deps: AppDeps, limit: number): TagSummary[] {
  return deps.db
    .select()
    .from(tags)
    .orderBy(desc(tags.novelCount), desc(tags.slug))
    .limit(limit)
    .all()
    .map(toTagSummary);
}
