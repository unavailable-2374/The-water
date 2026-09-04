import { z } from 'zod';
import { LIMITS } from '../constants';
import { NovelDetailSchema, VersionSummarySchema } from '../novel';
import { StoryBibleSchema, StorylineDocSchema } from '../storyline';

export const ChapterManifestEntrySchema = z.object({
  index: z.number().int().min(0).max(LIMITS.MAX_CHAPTERS_PER_VERSION - 1),
  title: z.string().max(LIMITS.NOVEL_TITLE_MAX),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  charCount: z.number().int().min(0).max(LIMITS.MAX_CHARS_PER_CHAPTER),
});
export type ChapterManifestEntry = z.infer<typeof ChapterManifestEntrySchema>;

export const CreateVersionRequestSchema = z.object({
  storyline: StorylineDocSchema,
  bible: StoryBibleSchema.nullable().default(null),
  chapters: z.array(ChapterManifestEntrySchema).min(1).max(LIMITS.MAX_CHAPTERS_PER_VERSION),
  changeNote: z.string().max(500).optional(),
});
export type CreateVersionRequest = z.infer<typeof CreateVersionRequestSchema>;

export const CreateVersionResponseSchema = z.object({
  version: VersionSummarySchema,
  missingHashes: z.array(z.string()),
});
export type CreateVersionResponse = z.infer<typeof CreateVersionResponseSchema>;

export const VersionStatusResponseSchema = z.object({
  version: VersionSummarySchema,
  missingHashes: z.array(z.string()).optional(),
});

export const CommitVersionResponseSchema = z.object({
  version: VersionSummarySchema,
  novel: NovelDetailSchema,
});
export type CommitVersionResponse = z.infer<typeof CommitVersionResponseSchema>;

// ---- 版本回滚（§3.2）----

/** `PUT /novels/:id/current-version`：把某个已提交版本设为当前版本。 */
export const SetCurrentVersionRequestSchema = z.object({ versionId: z.string().min(1).max(64) });
export type SetCurrentVersionRequest = z.infer<typeof SetCurrentVersionRequestSchema>;

/** 回滚成功后返回新的当前版本与刷新过反规范化字段的小说详情。 */
export const SetCurrentVersionResponseSchema = z.object({
  version: VersionSummarySchema,
  novel: NovelDetailSchema,
});
export type SetCurrentVersionResponse = z.infer<typeof SetCurrentVersionResponseSchema>;
