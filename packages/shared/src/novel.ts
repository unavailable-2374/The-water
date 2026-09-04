import { z } from 'zod';
import { LIMITS } from './constants';

export const LicenseSchema = z.enum(['all-rights-reserved', 'cc-by', 'cc-by-sa', 'cc-by-nc', 'cc-by-nc-sa', 'cc0']);
export type License = z.infer<typeof LicenseSchema>;
export const LICENSE_LABELS: Record<License, string> = {
  'all-rights-reserved': '保留所有权利',
  'cc-by': 'CC BY 署名',
  'cc-by-sa': 'CC BY-SA 署名-相同方式共享',
  'cc-by-nc': 'CC BY-NC 署名-非商业',
  'cc-by-nc-sa': 'CC BY-NC-SA 署名-非商业-相同方式共享',
  cc0: 'CC0 公有领域',
};
export const SHARE_ALIKE_LICENSES: License[] = ['cc-by-sa', 'cc-by-nc-sa'];

export const WritingStatusSchema = z.enum(['ongoing', 'completed']);
export const VisibilitySchema = z.enum(['unpublished', 'public', 'unlisted']);
export const ModerationStatusSchema = z.enum(['ok', 'hidden', 'removed']);

export const UserSchema = z.object({
  id: z.string(),
  email: z.string().email().optional(),
  handle: z.string(),
  displayName: z.string(),
  bio: z.string().nullable().optional(),
  role: z.enum(['user', 'admin']).default('user'),
  createdAt: z.string(),
});
export type User = z.infer<typeof UserSchema>;

export const AuthorRefSchema = z.object({ id: z.string(), displayName: z.string() });

/**
 * 带 @用户名的作者引用。NovelSummary、动态、评论都用它；
 * AuthorRefSchema 保持原样，因为 NovelBundleV1 里已经持久化了它的形状。
 */
export const AuthorCardSchema = AuthorRefSchema.extend({ handle: z.string() });
export type AuthorCard = z.infer<typeof AuthorCardSchema>;

export const NovelRefSchema = z.object({
  id: z.string(),
  title: z.string(),
  authorDisplayName: z.string(),
  visibility: z.enum(['public', 'unavailable']),
});
export type NovelRef = z.infer<typeof NovelRefSchema>;

export const VersionSummarySchema = z.object({
  id: z.string(),
  novelId: z.string(),
  versionNumber: z.number().int(),
  status: z.enum(['draft', 'committed', 'aborted']),
  storylineHash: z.string(),
  chapterCount: z.number().int(),
  charCount: z.number().int(),
  changeNote: z.string().nullable(),
  createdAt: z.string(),
  committedAt: z.string().nullable(),
});
export type VersionSummary = z.infer<typeof VersionSummarySchema>;

export const NovelSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  language: z.string(),
  writingStatus: WritingStatusSchema,
  license: LicenseSchema,
  allowDerivatives: z.boolean(),
  visibility: VisibilitySchema,
  author: AuthorCardSchema,
  chapterCount: z.number().int(),
  charCount: z.number().int(),
  viewCount: z.number().int(),
  likeCount: z.number().int(),
  forkCount: z.number().int(),
  isDerivative: z.boolean(),
  publishedAt: z.string().nullable(),
  lastPublishedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type NovelSummary = z.infer<typeof NovelSummarySchema>;

export const NovelDetailSchema = NovelSummarySchema.extend({
  moderationStatus: ModerationStatusSchema,
  currentVersion: VersionSummarySchema.nullable(),
  source: z
    .object({ novel: NovelRefSchema, versionId: z.string(), versionNumber: z.number().int() })
    .nullable(),
  rootNovelId: z.string(),
  depth: z.number().int(),
  commentCount: z.number().int(),
  /** 服务端未配置 PUBLIC_BASE_URL 时为 null。 */
  shareUrl: z.string().nullable(),
  viewer: z
    .object({
      liked: z.boolean(),
      forked: z.boolean(),
      followingAuthor: z.boolean(),
      blockedAuthor: z.boolean(),
    })
    .nullable(),
});
export type NovelDetail = z.infer<typeof NovelDetailSchema>;

export const ChapterMetaSchema = z.object({
  index: z.number().int().min(0),
  title: z.string().max(LIMITS.NOVEL_TITLE_MAX),
  charCount: z.number().int(),
  hash: z.string(),
});
export type ChapterMeta = z.infer<typeof ChapterMetaSchema>;

export const ChapterContentSchema = ChapterMetaSchema.extend({
  content: z.string(),
  prev: z.number().int().nullable(),
  next: z.number().int().nullable(),
});
export type ChapterContent = z.infer<typeof ChapterContentSchema>;
