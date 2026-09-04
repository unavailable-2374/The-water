import { z } from 'zod';
import { LicenseSchema, WritingStatusSchema, ChapterMetaSchema } from '../novel';
import { StorylineDocSchema, StoryBibleSchema } from '../storyline';

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
