import { z } from 'zod';
import { LIMITS } from '../constants';
import { LicenseSchema, NovelDetailSchema, NovelSummarySchema, VersionSummarySchema, WritingStatusSchema } from '../novel';
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
  visibility: z.enum(['public', 'unlisted']).optional(),
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
