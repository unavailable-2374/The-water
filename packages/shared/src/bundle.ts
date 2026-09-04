import { z } from 'zod';
import { AuthorRefSchema, LicenseSchema, WritingStatusSchema } from './novel';
import { StoryBibleSchema, StorylineDocSchema } from './storyline';

export const NovelBundleV1Schema = z.object({
  bundleVersion: z.literal(1),
  exportedAt: z.string(),
  server: z.object({ baseUrl: z.string() }),
  novel: z.object({
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    tags: z.array(z.string()),
    language: z.string(),
    writingStatus: WritingStatusSchema,
    license: LicenseSchema,
    allowDerivatives: z.boolean(),
    author: AuthorRefSchema,
  }),
  version: z.object({
    id: z.string(),
    versionNumber: z.number().int(),
    committedAt: z.string().nullable(),
    storylineHash: z.string(),
    chapterCount: z.number().int(),
    charCount: z.number().int(),
  }),
  storyline: StorylineDocSchema,
  bible: StoryBibleSchema.nullable(),
  chapters: z.array(
    z.object({ index: z.number().int(), title: z.string(), hash: z.string(), content: z.string() }),
  ),
  lineage: z.object({
    sourceNovelId: z.string().nullable(),
    sourceVersionId: z.string().nullable(),
    rootNovelId: z.string(),
    depth: z.number().int(),
  }),
  fork: z.object({ id: z.string() }).nullable(),
});
export type NovelBundleV1 = z.infer<typeof NovelBundleV1Schema>;

/** fork 后桌面端本地记录的溯源信息。 */
export const NovelOriginSchema = z.object({
  serverUrl: z.string(),
  forkId: z.string(),
  sourceNovelId: z.string(),
  sourceVersionId: z.string(),
  sourceVersionNumber: z.number().int(),
  sourceTitle: z.string(),
  sourceAuthorId: z.string(),
  sourceAuthorDisplayName: z.string(),
  sourceLicense: LicenseSchema,
  rootNovelId: z.string(),
  forkedAt: z.string(),
});
export type NovelOrigin = z.infer<typeof NovelOriginSchema>;
