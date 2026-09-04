import { z } from 'zod';
import { AttributionSchema } from '../bundle';
import { LIMITS } from '../constants';
import {
  LicenseSchema,
  NovelDetailSchema,
  NovelSummarySchema,
  VersionSummarySchema,
  VisibilitySchema,
  WritingStatusSchema,
} from '../novel';
import { pageSchema } from './common';

const TagsSchema = z.array(z.string().trim().min(1).max(LIMITS.TAG_MAX)).max(LIMITS.TAGS_MAX_COUNT);

export const CreateNovelRequestSchema = z.object({
  title: z.string().trim().min(1).max(LIMITS.NOVEL_TITLE_MAX),
  summary: z.string().max(LIMITS.NOVEL_SUMMARY_MAX).default(''),
  tags: TagsSchema.default([]),
  language: z.string().max(16).default('zh-CN'),
  writingStatus: WritingStatusSchema.default('ongoing'),
  license: LicenseSchema,
  allowDerivatives: z.boolean(),
  visibility: z.enum(['public', 'unlisted']).default('public'),
  source: z.object({ forkId: z.string() }).optional(),
});
export type CreateNovelRequest = z.infer<typeof CreateNovelRequestSchema>;

export const UpdateNovelRequestSchema = z.object({
  title: z.string().trim().min(1).max(LIMITS.NOVEL_TITLE_MAX).optional(),
  summary: z.string().max(LIMITS.NOVEL_SUMMARY_MAX).optional(),
  tags: TagsSchema.optional(),
  writingStatus: WritingStatusSchema.optional(),
  license: LicenseSchema.optional(),
  allowDerivatives: z.boolean().optional(),
  /**
   * §3.2 下架与回滚：允许回到 `unpublished`。
   * - `unpublished` = 下架，保留全部数据与谱系，随时可再上架（不同于不可逆的软删除）；
   * - `public` / `unlisted` 同时写入 publishVisibility，下次提交版本时沿用。
   */
  visibility: VisibilitySchema.optional(),
});
export type UpdateNovelRequest = z.infer<typeof UpdateNovelRequestSchema>;

/** `POST /novels`、`GET|PATCH /novels/:id` 的响应体。 */
export const NovelResponseSchema = z.object({ novel: NovelDetailSchema });
export type NovelResponse = z.infer<typeof NovelResponseSchema>;

/** `GET /novels`、`GET /me/novels`、`GET /me/likes` 的分页响应。 */
export const NovelListResponseSchema = pageSchema(NovelSummarySchema);
export type NovelListResponse = z.infer<typeof NovelListResponseSchema>;

/** `GET /novels/:id/versions` 的分页响应。 */
export const VersionListResponseSchema = pageSchema(VersionSummarySchema);
export type VersionListResponse = z.infer<typeof VersionListResponseSchema>;

// ---- 「想读」书架与云端阅读进度（§3.4）----

/** `PUT|DELETE /novels/:id/bookmark` 的响应。 */
export const BookmarkResponseSchema = z.object({ bookmarked: z.boolean() });
export type BookmarkResponse = z.infer<typeof BookmarkResponseSchema>;

/** `GET /me/bookmarks` 的分页响应（与 `GET /me/likes` 分开：喜欢是表态，想读是书架）。 */
export const BookmarkListResponseSchema = pageSchema(NovelSummarySchema);
export type BookmarkListResponse = z.infer<typeof BookmarkListResponseSchema>;

export const ReadingProgressSchema = z.object({
  novelId: z.string(),
  /** 章节序号，与 chapters 接口一致，从 0 开始。 */
  chapterIndex: z.number().int().min(0),
  /** 章内百分比 0–100。 */
  percent: z.number().int().min(0).max(100),
  updatedAt: z.string(),
});
export type ReadingProgress = z.infer<typeof ReadingProgressSchema>;

export const UpdateReadingProgressRequestSchema = z.object({
  chapterIndex: z.number().int().min(0).max(LIMITS.MAX_CHAPTERS_PER_VERSION),
  percent: z.number().int().min(0).max(100).default(0),
});
export type UpdateReadingProgressRequest = z.infer<typeof UpdateReadingProgressRequestSchema>;

/** `GET|PUT /novels/:id/progress`：没读过为 null。 */
export const ReadingProgressResponseSchema = z.object({ progress: ReadingProgressSchema.nullable() });
export type ReadingProgressResponse = z.infer<typeof ReadingProgressResponseSchema>;

export const ReadingProgressEntrySchema = z.object({
  novel: NovelSummarySchema,
  progress: ReadingProgressSchema,
});
export type ReadingProgressEntry = z.infer<typeof ReadingProgressEntrySchema>;

/** `GET /me/progress` 的分页响应（在读的书，按最近阅读排序）。 */
export const ReadingProgressListResponseSchema = pageSchema(ReadingProgressEntrySchema);
export type ReadingProgressListResponse = z.infer<typeof ReadingProgressListResponseSchema>;

// ---- 许可与署名（§3.7）----

/** `GET /novels/:id/attribution`：作品页的许可展示与二创署名都读它。 */
export const AttributionResponseSchema = z.object({ attribution: AttributionSchema });
export type AttributionResponse = z.infer<typeof AttributionResponseSchema>;
