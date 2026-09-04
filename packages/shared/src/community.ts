/**
 * 社区层契约：公开身份（@用户名、作者主页）、关注/屏蔽、动态流、评论、分享。
 * 与 incentive.ts 分工：这里是"人与人、人与作品"的关系与展示，那里是积分规则。
 */
import { z } from 'zod';
import { LIMITS } from './constants';
import { AuthorCardSchema, NovelRefSchema, NovelSummarySchema } from './novel';
import { pageSchema, CursorQuerySchema } from './api/common';
import { BadgeIdSchema, LevelSchema } from './incentive';

// ---- @用户名 ----

export const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

/** 与网页路由、API 路径段冲突或含义特殊的用户名，禁止占用。 */
export const RESERVED_HANDLES: readonly string[] = [
  'admin', 'administrator', 'me', 'my', 'api', 'app', 'n', 'u', 'c', 'feed', 'leaderboard',
  'users', 'user', 'novels', 'novel', 'health', 'static', 'assets', 'avatar', 'share',
  'about', 'help', 'support', 'settings', 'login', 'logout', 'register', 'signup', 'signin',
  'the_water', 'thewater', 'official', 'system', 'root', 'null', 'undefined',
];

export const HandleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(HANDLE_RE, `用户名只能用 ${LIMITS.HANDLE_MIN}–${LIMITS.HANDLE_MAX} 个小写字母、数字或下划线`)
  .refine((h) => !RESERVED_HANDLES.includes(h), '该用户名已被保留，换一个吧');

/** 校验用户名并返回中文错误；合法返回 null。桌面端表单直接用。 */
export function validateHandle(raw: string): string | null {
  const h = raw.trim().toLowerCase();
  if (!h) return '请填写用户名';
  if (!HANDLE_RE.test(h)) return `用户名只能用 ${LIMITS.HANDLE_MIN}–${LIMITS.HANDLE_MAX} 个小写字母、数字或下划线`;
  if (RESERVED_HANDLES.includes(h)) return '该用户名已被保留，换一个吧';
  return null;
}

/** 由用户 id 生成兜底用户名（服务端注册与迁移回填共用同一形状）。 */
export function fallbackHandle(userId: string): string {
  const hex = userId.replace(/-/g, '').toLowerCase();
  return `u_${hex.slice(20, 32) || hex.slice(-12) || '000000000000'}`;
}

// ---- 用户展示 ----

/** 关注/粉丝/屏蔽列表与排行榜的行。 */
export const UserCardSchema = z.object({
  id: z.string(),
  handle: z.string(),
  displayName: z.string(),
  bio: z.string().nullable(),
  followerCount: z.number().int(),
  points: z.number().int(),
  level: LevelSchema,
});
export type UserCard = z.infer<typeof UserCardSchema>;

export const UserStatsSchema = z.object({
  followingCount: z.number().int(),
  /** 已公开的原创数 / 二创数。 */
  novelCount: z.number().int(),
  derivativeCount: z.number().int(),
  /** 本人作品被二创的次数。 */
  derivedCount: z.number().int(),
  likeReceived: z.number().int(),
  viewReceived: z.number().int(),
});
export type UserStats = z.infer<typeof UserStatsSchema>;

export const UserBadgeSchema = z.object({ id: BadgeIdSchema, awardedAt: z.string() });

export const ViewerRelationSchema = z.object({
  following: z.boolean(),
  followedBy: z.boolean(),
  blocked: z.boolean(),
  blockedBy: z.boolean(),
});
export type ViewerRelation = z.infer<typeof ViewerRelationSchema>;

export const UserProfileSchema = UserCardSchema.extend({
  createdAt: z.string(),
  stats: UserStatsSchema,
  badges: z.array(UserBadgeSchema),
  /** 未登录时为 null。 */
  viewer: ViewerRelationSchema.nullable(),
  /** 服务端未配置 PUBLIC_BASE_URL 时为 null。 */
  shareUrl: z.string().nullable(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

export const UserProfileResponseSchema = z.object({ user: UserProfileSchema });
export type UserProfileResponse = z.infer<typeof UserProfileResponseSchema>;

export const UserListResponseSchema = pageSchema(UserCardSchema);
export type UserListResponse = z.infer<typeof UserListResponseSchema>;

export const UserNovelsQuerySchema = CursorQuerySchema.extend({
  kind: z.enum(['all', 'original', 'derivative']).default('all'),
});
export type UserNovelsQuery = z.infer<typeof UserNovelsQuerySchema>;

export const FollowResponseSchema = z.object({ following: z.boolean(), followerCount: z.number().int() });
export type FollowResponse = z.infer<typeof FollowResponseSchema>;

export const BlockResponseSchema = z.object({ blocked: z.boolean() });
export type BlockResponse = z.infer<typeof BlockResponseSchema>;

// ---- 动态流 ----

export const ActivityKindSchema = z.enum(['novel_published', 'version_published', 'novel_completed']);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

export const FeedItemSchema = z.object({
  id: z.string(),
  kind: ActivityKindSchema,
  actor: AuthorCardSchema,
  novel: NovelSummarySchema,
  /** 二创时的直接来源；不可见则为「已下架」占位。 */
  source: NovelRefSchema.nullable(),
  version: z.object({ id: z.string(), versionNumber: z.number().int(), changeNote: z.string().nullable() }).nullable(),
  createdAt: z.string(),
});
export type FeedItem = z.infer<typeof FeedItemSchema>;

export const FeedQuerySchema = CursorQuerySchema.extend({
  scope: z.enum(['following', 'all']).default('following'),
  /** 只看某位作者的动态（作者主页用）。 */
  actorId: z.string().max(64).optional(),
});
export type FeedQuery = z.infer<typeof FeedQuerySchema>;

export const FeedResponseSchema = pageSchema(FeedItemSchema);
export type FeedResponse = z.infer<typeof FeedResponseSchema>;

// ---- 评论 ----

export const CommentStatusSchema = z.enum(['ok', 'deleted', 'hidden']);

export const CreateCommentRequestSchema = z.object({
  body: z.string().trim().min(1).max(LIMITS.COMMENT_BODY_MAX),
  /** 回复某条评论（可以是顶层，也可以是回复；服务端会把 parentId 归一到顶层）。 */
  replyToId: z.string().max(64).optional(),
  /** 章节级留言：与版本章节列表同一套下标（从 0 开始）；缺省即作品级留言。 */
  chapterIndex: z.number().int().min(0).max(LIMITS.MAX_CHAPTERS_PER_VERSION).optional(),
});
export type CreateCommentRequest = z.infer<typeof CreateCommentRequestSchema>;

/** 留言编辑窗口：发出后 15 分钟内可改，超时只能删。 */
export const COMMENT_EDIT_WINDOW_MS = 15 * 60_000;

export const UpdateCommentRequestSchema = z.object({
  body: z.string().trim().min(1).max(LIMITS.COMMENT_BODY_MAX),
});
export type UpdateCommentRequest = z.infer<typeof UpdateCommentRequestSchema>;

/** 留言列表筛选：数字=只看该章，'novel'=只看作品级，缺省=全部。 */
export const CommentListQuerySchema = CursorQuerySchema.extend({
  chapter: z.union([z.literal('novel'), z.coerce.number().int().min(0).max(LIMITS.MAX_CHAPTERS_PER_VERSION)]).optional(),
});
export type CommentListQuery = z.infer<typeof CommentListQuerySchema>;

/** 从留言正文里解析 @用户名（小写去重，最多 10 个，避免一条留言 @ 全站）。 */
export function parseMentions(body: string, max = 10): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // 前面必须是行首或非用户名字符，避免把邮箱 a@b 当成提及。
  for (const m of body.matchAll(/(^|[^a-z0-9_@])@([a-z0-9_]{3,20})(?![a-z0-9_])/gi)) {
    const handle = m[2]!.toLowerCase();
    if (seen.has(handle)) continue;
    seen.add(handle);
    out.push(handle);
    if (out.length >= max) break;
  }
  return out;
}

export const CommentSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  /** 顶层为 null；回复恒指向顶层评论。 */
  parentId: z.string().nullable(),
  replyToId: z.string().nullable(),
  replyToName: z.string().nullable(),
  author: AuthorCardSchema,
  /** 已删除/被隐藏时为空串。 */
  body: z.string(),
  status: CommentStatusSchema,
  replyCount: z.number().int(),
  /** 非空表示这条留言锚在某一章上；空表示作品级留言。 */
  chapterIndex: z.number().int().nullable(),
  likeCount: z.number().int(),
  /** 编辑过的留言带时间戳，界面上标「已编辑」。 */
  editedAt: z.string().nullable(),
  createdAt: z.string(),
  viewer: z.object({ canDelete: z.boolean(), canEdit: z.boolean(), liked: z.boolean() }).nullable(),
});
export type Comment = z.infer<typeof CommentSchema>;

export const CommentResponseSchema = z.object({ comment: CommentSchema });
export type CommentResponse = z.infer<typeof CommentResponseSchema>;

export const CommentListResponseSchema = pageSchema(CommentSchema);
export type CommentListResponse = z.infer<typeof CommentListResponseSchema>;

export const CommentModerationSchema = z.object({
  status: z.enum(['ok', 'hidden']),
  note: z.string().max(500).optional(),
});

// ---- 积分与榜单的响应（依赖 UserCard / NovelSummary，故放在这里） ----

export const PointsLedgerEntrySchema = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  points: z.number().int(),
  refType: z.enum(['novel', 'user', 'comment']),
  refId: z.string(),
  createdAt: z.string(),
});
export type PointsLedgerEntry = z.infer<typeof PointsLedgerEntrySchema>;

export const MyPointsResponseSchema = z.object({
  points: z.number().int(),
  level: LevelSchema,
  badges: z.array(UserBadgeSchema),
  ledger: pageSchema(PointsLedgerEntrySchema),
});
export type MyPointsResponse = z.infer<typeof MyPointsResponseSchema>;

export const LeaderboardQuerySchema = z.object({
  board: z.enum(['authors', 'novels']).default('authors'),
  period: z.enum(['week', 'month', 'all']).default('week'),
});
export type LeaderboardQuery = z.infer<typeof LeaderboardQuerySchema>;

export const LeaderboardResponseSchema = z.object({
  board: z.enum(['authors', 'novels']),
  period: z.enum(['week', 'month', 'all']),
  generatedAt: z.string(),
  authors: z.array(UserCardSchema.extend({ rank: z.number().int(), points: z.number().int() })).nullable(),
  novels: z.array(NovelSummarySchema.extend({ rank: z.number().int(), points: z.number().int() })).nullable(),
});
export type LeaderboardResponse = z.infer<typeof LeaderboardResponseSchema>;

// ---- 分享 ----

export interface ShareCardInput {
  title: string;
  summary?: string | null;
  authorName: string;
  handle?: string | null;
  chapterCount?: number;
  charCount?: number;
  writingStatus?: 'ongoing' | 'completed';
  likeCount?: number;
  isDerivative?: boolean;
  sourceTitle?: string | null;
}

function clip(s: string, max: number): string {
  const chars = Array.from(s.trim());
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}…`;
}

/** 站外分享用的一段中文文案。url 必须是服务端网页地址，绝不是桌面端 hash 路由。 */
export function buildShareText(n: ShareCardInput, url: string): string {
  const lines: string[] = [];
  lines.push(`《${n.title}》 · ${n.authorName}${n.handle ? `（@${n.handle}）` : ''}`);
  if (n.isDerivative && n.sourceTitle) lines.push(`改编自《${n.sourceTitle}》`);
  const summary = n.summary?.trim();
  if (summary) lines.push(clip(summary, 80));
  const stats: string[] = [];
  if (n.chapterCount) stats.push(`${n.chapterCount} 章`);
  if (n.charCount) stats.push(`${n.charCount.toLocaleString('en-US')} 字`);
  if (n.writingStatus) stats.push(n.writingStatus === 'completed' ? '已完结' : '连载中');
  if (n.likeCount) stats.push(`${n.likeCount} 人喜欢`);
  if (stats.length) lines.push(stats.join(' · '));
  lines.push(url);
  lines.push('—— 来自 The Water · 读一本书，写一个故事');
  return lines.join('\n');
}

// ---- 生成式头像 ----

/** 由任意种子得到稳定的 0..359 色相。桌面端书封与头像共用同一散列。 */
export function hueFromSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** 确定性几何头像（服务端网页 <img> 用）。无外部资源、无脚本，可直接当作 image/svg+xml 返回。 */
export function avatarSvg(seed: string, size = 96): string {
  const hue = hueFromSeed(seed);
  const h2 = (hue + 38) % 360;
  const s = Math.max(16, Math.min(512, Math.round(size)));
  const r = s / 2;
  // 由种子决定三个装饰圆的位置与大小，形状稳定但各不相同。
  const n = hueFromSeed(`${seed}:shape`);
  const cx = 0.28 + ((n >> 2) % 45) / 100;
  const cy = 0.3 + ((n >> 5) % 40) / 100;
  const rr = 0.18 + ((n >> 8) % 22) / 100;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 100 100" role="img" aria-label="头像">`,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0%" stop-color="hsl(${hue} 45% 72%)"/><stop offset="100%" stop-color="hsl(${h2} 40% 52%)"/>`,
    `</linearGradient></defs>`,
    `<rect width="100" height="100" rx="${(r / s) * 100}" fill="url(#g)"/>`,
    `<circle cx="${(cx * 100).toFixed(1)}" cy="${(cy * 100).toFixed(1)}" r="${(rr * 100).toFixed(1)}" fill="hsl(${h2} 55% 88%)" opacity="0.55"/>`,
    `<circle cx="${((1 - cx) * 100).toFixed(1)}" cy="${((1 - cy) * 100).toFixed(1)}" r="${(rr * 70).toFixed(1)}" fill="hsl(${hue} 60% 30%)" opacity="0.28"/>`,
    `</svg>`,
  ].join('');
}
