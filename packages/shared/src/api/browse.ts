import { z } from 'zod';
import { FeedItemSchema, FeedQuerySchema } from '../community';
import { LIMITS } from '../constants';
import { LicenseSchema, WritingStatusSchema, ChapterMetaSchema } from '../novel';
import { StorylineDocSchema, StoryBibleSchema } from '../storyline';
import { CursorQuerySchema, pageSchema } from './common';

const boolParam = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

export const BrowseQuerySchema = z.object({
  sort: z.enum(['latest', 'popular', 'likes', 'forks']).default('latest'),
  q: z.string().trim().max(50).optional(),
  tag: z.string().trim().max(20).optional(),
  license: LicenseSchema.optional(),
  writingStatus: WritingStatusSchema.optional(),
  allowDerivatives: boolParam.optional(),
  originalsOnly: boolParam.optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type BrowseQuery = z.infer<typeof BrowseQuerySchema>;

export const ChaptersQuerySchema = z.object({
  from: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(200),
});

export const ChapterListResponseSchema = z.object({ items: z.array(ChapterMetaSchema), total: z.number().int() });
export const StorylineResponseSchema = z.object({
  storyline: StorylineDocSchema,
  bible: StoryBibleSchema.nullable(),
  storylineHash: z.string(),
});

// ---- 标签目录（§3.4）----

/**
 * 标签归一化规则：先去首尾空白，再把 A–Z 转成小写。
 * 与迁移 `0003_lumpy_mister_fear.sql` 的 `lower(trim(...))` 逐字一致 ——
 * SQLite 的 `lower()` 只处理 ASCII，所以这里不能用 JS 的全 Unicode `toLowerCase()`，
 * 否则回填出来的 slug 和运行时算出来的 slug 会对不上。
 */
export function normalizeTagSlug(raw: string): string {
  return raw.trim().replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

export const TagSummarySchema = z.object({
  /** 归一化后的键，浏览接口的 `tag` 参数用它。 */
  slug: z.string(),
  /** 展示用写法，取最近一次公开作品里的原始写法。 */
  label: z.string(),
  /** 公开可见（public + 审核通过 + 未删除）的作品数。 */
  novelCount: z.number().int(),
});
export type TagSummary = z.infer<typeof TagSummarySchema>;

/** `GET /tags` 的分页响应。 */
export const TagListResponseSchema = pageSchema(TagSummarySchema);
export type TagListResponse = z.infer<typeof TagListResponseSchema>;

export const TagDirectoryQuerySchema = CursorQuerySchema.extend({
  /** popular 按作品数倒序，name 按 slug 升序；两种游标都稳定。 */
  sort: z.enum(['popular', 'name']).default('popular'),
  /** 标签名模糊匹配（可选）。 */
  q: z.string().trim().max(LIMITS.TAG_MAX).optional(),
});
export type TagDirectoryQuery = z.infer<typeof TagDirectoryQuerySchema>;

/** `GET /tags/popular`：首页/浏览页的热门标签，无分页。 */
export const PopularTagsResponseSchema = z.object({ items: z.array(TagSummarySchema) });
export type PopularTagsResponse = z.infer<typeof PopularTagsResponseSchema>;

export const PopularTagsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type PopularTagsQuery = z.infer<typeof PopularTagsQuerySchema>;

// ---- 用户搜索（§3.4）----

/**
 * `GET /users?q=`。匹配 @用户名与昵称。
 * 排序为「前缀命中优先，其次按用户名升序」—— 两项都与可变计数器无关，翻页不漂移。
 */
export const UserSearchQuerySchema = CursorQuerySchema.extend({
  q: z.string().trim().min(1).max(50),
});
export type UserSearchQuery = z.infer<typeof UserSearchQuerySchema>;

// ---- 动态流折叠与已读态（§3.4）----

/**
 * 折叠后的动态项。同一作者的同一本书只出一条（取最新的一条动态），
 * `collapsedCount` 是被折叠进来的动态总数（10 章更新 = 1 条，collapsedCount = 10）。
 *
 * 注：这两个字段是 `FeedItemSchema` 的超集，旧的 `FeedResponseSchema` 依然能校验通过。
 */
export const FoldedFeedItemSchema = FeedItemSchema.extend({
  collapsedCount: z.number().int().min(1),
  /** 已读态：登录用户在这条动态之后读过这本书就是 true；未登录恒为 false。 */
  read: z.boolean(),
});
export type FoldedFeedItem = z.infer<typeof FoldedFeedItemSchema>;

export const FoldedFeedResponseSchema = pageSchema(FoldedFeedItemSchema);
export type FoldedFeedResponse = z.infer<typeof FoldedFeedResponseSchema>;

export const FoldedFeedQuerySchema = FeedQuerySchema.extend({
  /** 默认折叠；传 false 拿回逐条的原始动态。 */
  collapse: boolParam.default(true),
  /** 只看未读。 */
  unreadOnly: boolParam.optional(),
});
export type FoldedFeedQuery = z.infer<typeof FoldedFeedQuerySchema>;
