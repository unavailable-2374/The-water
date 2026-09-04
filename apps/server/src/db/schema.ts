import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { StoryBible, StorylineDoc } from '@the-water/shared';

/**
 * 列类型词汇受限：text / integer / integer{boolean} / integer{timestamp_ms} / text{json}。
 * casing 由 drizzle 客户端统一设为 snake_case。
 */
const ts = (name?: string) => (name ? integer(name, { mode: 'timestamp_ms' }) : integer({ mode: 'timestamp_ms' }));
const bool = () => integer({ mode: 'boolean' });

export const users = sqliteTable(
  'users',
  {
    id: text().primaryKey(),
    email: text().notNull(),
    passwordHash: text().notNull(),
    /** 公开 @用户名，小写 [a-z0-9_]{3,20}，注册时自动生成、可自行更改。 */
    handle: text().notNull(),
    displayName: text().notNull(),
    bio: text(),
    role: text({ enum: ['user', 'admin'] }).notNull().default('user'),
    /** 账号状态：suspended 为限期禁言，banned 为永久封禁；两者都不可写入内容。 */
    status: text({ enum: ['active', 'suspended', 'banned'] }).notNull().default('active'),
    /** status='suspended' 时的解禁时间；到期后视为 active。 */
    suspendedUntil: ts(),
    statusReason: text(),
    /** 邮箱验证通过时间；未验证的账号不可被 ADMIN_EMAILS 提权。 */
    emailVerifiedAt: ts(),
    /** 注销账号后置位；置位后邮箱与 handle 已被匿名化。 */
    deletedAt: ts(),
    followerCount: integer().notNull().default(0),
    followingCount: integer().notNull().default(0),
    /** point_ledger 的缓存合计，与账本在同一事务内更新。 */
    points: integer().notNull().default(0),
    createdAt: ts().notNull(),
    updatedAt: ts().notNull(),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(t.email),
    uniqueIndex('users_handle_uq').on(t.handle),
    index('users_points_idx').on(t.points),
    index('users_status_idx').on(t.status),
  ],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text().notNull(),
    clientLabel: text(),
    createdAt: ts().notNull(),
    lastUsedAt: ts().notNull(),
    expiresAt: ts().notNull(),
  },
  (t) => [uniqueIndex('sessions_token_hash_uq').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

export const novels = sqliteTable(
  'novels',
  {
    id: text().primaryKey(),
    authorId: text()
      .notNull()
      .references(() => users.id),
    title: text().notNull(),
    summary: text().notNull().default(''),
    tags: text({ mode: 'json' }).$type<string[]>().notNull().default([]),
    language: text().notNull().default('zh-CN'),
    writingStatus: text({ enum: ['ongoing', 'completed'] }).notNull().default('ongoing'),
    license: text({
      enum: ['all-rights-reserved', 'cc-by', 'cc-by-sa', 'cc-by-nc', 'cc-by-nc-sa', 'cc0'],
    }).notNull(),
    allowDerivatives: bool().notNull().default(false),
    /** 实际可见性；首次提交前始终为 unpublished。 */
    visibility: text({ enum: ['unpublished', 'public', 'unlisted'] }).notNull().default('unpublished'),
    /** 作者期望的发布可见性，首次提交时生效。 */
    publishVisibility: text({ enum: ['public', 'unlisted'] }).notNull().default('public'),
    moderationStatus: text({ enum: ['ok', 'hidden', 'removed'] }).notNull().default('ok'),
    moderationNote: text(),
    currentVersionId: text(),
    sourceNovelId: text(),
    sourceVersionId: text(),
    rootNovelId: text().notNull(),
    depth: integer().notNull().default(0),
    forkId: text(),
    chapterCount: integer().notNull().default(0),
    charCount: integer().notNull().default(0),
    viewCount: integer().notNull().default(0),
    likeCount: integer().notNull().default(0),
    forkCount: integer().notNull().default(0),
    commentCount: integer().notNull().default(0),
    publishedAt: ts(),
    lastPublishedAt: ts(),
    deletedAt: ts(),
    createdAt: ts().notNull(),
    updatedAt: ts().notNull(),
  },
  (t) => [
    index('novels_author_idx').on(t.authorId),
    index('novels_root_idx').on(t.rootNovelId),
    index('novels_source_idx').on(t.sourceNovelId),
    index('novels_browse_latest_idx').on(t.visibility, t.moderationStatus, t.lastPublishedAt),
  ],
);

export interface ChapterManifestRow {
  index: number;
  title: string;
  hash: string;
  charCount: number;
}

export const novelVersions = sqliteTable(
  'novel_versions',
  {
    id: text().primaryKey(),
    novelId: text()
      .notNull()
      .references(() => novels.id, { onDelete: 'cascade' }),
    /** 草稿为 0，提交时分配。 */
    versionNumber: integer().notNull().default(0),
    status: text({ enum: ['draft', 'committed', 'aborted'] }).notNull().default('draft'),
    baseVersionId: text(),
    idempotencyKey: text(),
    storyline: text({ mode: 'json' }).$type<StorylineDoc>().notNull(),
    storylineHash: text().notNull(),
    bible: text({ mode: 'json' }).$type<StoryBible | null>(),
    /** 草稿期的章节清单；提交后写入 version_chapters。 */
    manifest: text({ mode: 'json' }).$type<ChapterManifestRow[]>().notNull(),
    changeNote: text(),
    chapterCount: integer().notNull().default(0),
    charCount: integer().notNull().default(0),
    createdAt: ts().notNull(),
    committedAt: ts(),
  },
  (t) => [
    uniqueIndex('novel_versions_idem_uq').on(t.novelId, t.idempotencyKey),
    index('novel_versions_novel_idx').on(t.novelId, t.status),
  ],
);

export const blobs = sqliteTable(
  'blobs',
  {
    hash: text().primaryKey(),
    content: text().notNull(),
    charCount: integer().notNull(),
    byteSize: integer().notNull(),
    firstUploaderId: text(),
    createdAt: ts().notNull(),
  },
  (t) => [index('blobs_uploader_idx').on(t.firstUploaderId), index('blobs_created_idx').on(t.createdAt)],
);

export const versionChapters = sqliteTable(
  'version_chapters',
  {
    versionId: text()
      .notNull()
      .references(() => novelVersions.id, { onDelete: 'cascade' }),
    index: integer().notNull(),
    title: text().notNull(),
    blobHash: text()
      .notNull()
      .references(() => blobs.hash),
    charCount: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.versionId, t.index] })],
);

export const forks = sqliteTable(
  'forks',
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id),
    sourceNovelId: text()
      .notNull()
      .references(() => novels.id),
    sourceVersionId: text()
      .notNull()
      .references(() => novelVersions.id),
    derivativeNovelId: text(),
    createdAt: ts().notNull(),
  },
  (t) => [
    index('forks_user_idx').on(t.userId),
    index('forks_source_idx').on(t.sourceNovelId),
    uniqueIndex('forks_user_source_uq').on(t.userId, t.sourceNovelId),
  ],
);

export const likes = sqliteTable(
  'likes',
  {
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    novelId: text()
      .notNull()
      .references(() => novels.id, { onDelete: 'cascade' }),
    createdAt: ts().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.novelId] }), index('likes_user_created_idx').on(t.userId, t.createdAt)],
);

export const viewEvents = sqliteTable(
  'view_events',
  {
    novelId: text()
      .notNull()
      .references(() => novels.id, { onDelete: 'cascade' }),
    viewerKey: text().notNull(),
    day: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.novelId, t.viewerKey, t.day] })],
);

export const reports = sqliteTable(
  'reports',
  {
    id: text().primaryKey(),
    novelId: text()
      .notNull()
      .references(() => novels.id, { onDelete: 'cascade' }),
    /** 非空表示举报的是该小说下的一条评论。 */
    commentId: text(),
    reporterId: text(),
    /** `${novelId}:${commentId ?? '-'}:${reporterId ?? viewerKey}`，同人同对象只记一条。 */
    dedupeKey: text().notNull().default(''),
    reason: text({ enum: ['plagiarism', 'illegal', 'adult', 'spam', 'other'] }).notNull(),
    detail: text(),
    status: text({ enum: ['open', 'resolved', 'dismissed'] }).notNull().default('open'),
    note: text(),
    createdAt: ts().notNull(),
    resolvedAt: ts(),
  },
  (t) => [index('reports_status_idx').on(t.status, t.createdAt), uniqueIndex('reports_dedupe_uq').on(t.dedupeKey)],
);

export const follows = sqliteTable(
  'follows',
  {
    followerId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    followeeId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: ts().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.followerId, t.followeeId] }),
    index('follows_followee_idx').on(t.followeeId, t.createdAt),
    index('follows_follower_idx').on(t.followerId, t.createdAt),
  ],
);

export const blocks = sqliteTable(
  'blocks',
  {
    blockerId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: ts().notNull(),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] }), index('blocks_blocked_idx').on(t.blockedId)],
);

/** 动态流事件。原创/二创是小说的属性，不体现在 kind 上。 */
export const activities = sqliteTable(
  'activities',
  {
    id: text().primaryKey(),
    actorId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text({ enum: ['novel_published', 'version_published', 'novel_completed'] }).notNull(),
    novelId: text()
      .notNull()
      .references(() => novels.id, { onDelete: 'cascade' }),
    versionId: text(),
    /** `${kind}:${novelId}:${versionId ?? '-'}`，保证同一事件只记一次。 */
    dedupeKey: text().notNull(),
    createdAt: ts().notNull(),
  },
  (t) => [
    uniqueIndex('activities_dedupe_uq').on(t.dedupeKey),
    index('activities_actor_idx').on(t.actorId, t.createdAt),
    index('activities_created_idx').on(t.createdAt),
  ],
);

/** 两级评论：parentId 恒指向顶层，replyToId 指向被回复的具体一条。 */
export const comments = sqliteTable(
  'comments',
  {
    id: text().primaryKey(),
    novelId: text()
      .notNull()
      .references(() => novels.id, { onDelete: 'cascade' }),
    authorId: text()
      .notNull()
      .references(() => users.id),
    parentId: text(),
    replyToId: text(),
    /** 非空表示这条留言锚在某一章上；空表示作品级留言。 */
    chapterIndex: integer(),
    body: text().notNull(),
    likeCount: integer().notNull().default(0),
    editedAt: ts(),
    status: text({ enum: ['ok', 'deleted', 'hidden'] }).notNull().default('ok'),
    /** 仅统计 status='ok' 的回复。 */
    replyCount: integer().notNull().default(0),
    createdAt: ts().notNull(),
    deletedAt: ts(),
  },
  (t) => [
    index('comments_novel_idx').on(t.novelId, t.parentId, t.createdAt),
    index('comments_chapter_idx').on(t.novelId, t.chapterIndex, t.createdAt),
    index('comments_parent_idx').on(t.parentId, t.createdAt),
    index('comments_author_idx').on(t.authorId, t.createdAt),
  ],
);

/** 积分账本，唯一的真相来源；users.points 是它的缓存合计。 */
export const pointLedger = sqliteTable(
  'point_ledger',
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** PointKind（见 packages/shared/src/incentive.ts）。 */
    kind: text().notNull(),
    points: integer().notNull(),
    refType: text({ enum: ['novel', 'user', 'comment'] }).notNull(),
    refId: text().notNull(),
    /** 每条规则的自然幂等键，见方案中的积分表。 */
    dedupeKey: text().notNull(),
    meta: text({ mode: 'json' }).$type<Record<string, unknown> | null>(),
    createdAt: ts().notNull(),
  },
  (t) => [
    uniqueIndex('point_ledger_dedupe_uq').on(t.dedupeKey),
    index('point_ledger_user_idx').on(t.userId, t.createdAt),
    index('point_ledger_period_idx').on(t.createdAt, t.userId),
    index('point_ledger_ref_idx').on(t.refType, t.refId, t.createdAt),
  ],
);

export const userBadges = sqliteTable(
  'user_badges',
  {
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    badge: text().notNull(),
    awardedAt: ts().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.badge] })],
);

/** 邮箱验证 / 找回密码令牌。只存哈希，明文仅出现在邮件里。 */
export const emailTokens = sqliteTable(
  'email_tokens',
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text({ enum: ['verify', 'reset'] }).notNull(),
    tokenHash: text().notNull(),
    expiresAt: ts().notNull(),
    usedAt: ts(),
    createdAt: ts().notNull(),
  },
  (t) => [
    uniqueIndex('email_tokens_hash_uq').on(t.tokenHash),
    index('email_tokens_user_idx').on(t.userId, t.kind, t.createdAt),
    index('email_tokens_expires_idx').on(t.expiresAt),
  ],
);

/** 审核审计日志：每次人工或自动审核动作都必须留痕。 */
export const moderationEvents = sqliteTable(
  'moderation_events',
  {
    id: text().primaryKey(),
    /** null 表示系统自动动作（如自动审核判定）。 */
    actorId: text(),
    targetType: text({ enum: ['novel', 'version', 'comment', 'user', 'report'] }).notNull(),
    targetId: text().notNull(),
    /** 如 novel_hide / novel_restore / comment_hide / user_ban / user_unban / report_resolve。 */
    action: text().notNull(),
    reason: text(),
    note: text(),
    meta: text({ mode: 'json' }).$type<Record<string, unknown> | null>(),
    createdAt: ts().notNull(),
  },
  (t) => [
    index('moderation_events_target_idx').on(t.targetType, t.targetId, t.createdAt),
    index('moderation_events_actor_idx').on(t.actorId, t.createdAt),
    index('moderation_events_created_idx').on(t.createdAt),
  ],
);

/** 站内通知。积分引擎 award() 与审核动作是事件源。 */
export const notifications = sqliteTable(
  'notifications',
  {
    id: text().primaryKey(),
    /** 收件人。 */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 触发者；系统通知为 null。 */
    actorId: text(),
    /** followed / commented / replied / forked / liked / badge / moderation / version_published。 */
    kind: text().notNull(),
    refType: text({ enum: ['novel', 'user', 'comment', 'badge', 'system'] }).notNull(),
    refId: text().notNull(),
    /** 渲染用的冗余字段，避免通知列表 N+1。 */
    title: text().notNull().default(''),
    body: text().notNull().default(''),
    readAt: ts(),
    /** 同一事件只通知一次。 */
    dedupeKey: text().notNull(),
    createdAt: ts().notNull(),
  },
  (t) => [
    uniqueIndex('notifications_dedupe_uq').on(t.dedupeKey),
    index('notifications_user_idx').on(t.userId, t.createdAt),
    index('notifications_unread_idx').on(t.userId, t.readAt, t.createdAt),
  ],
);

export const commentLikes = sqliteTable(
  'comment_likes',
  {
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    commentId: text()
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    createdAt: ts().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.commentId] }), index('comment_likes_comment_idx').on(t.commentId)],
);

/** 「想读」书架，与 likes（喜欢）分开。 */
export const bookmarks = sqliteTable(
  'bookmarks',
  {
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    novelId: text()
      .notNull()
      .references(() => novels.id, { onDelete: 'cascade' }),
    createdAt: ts().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.novelId] }),
    index('bookmarks_user_created_idx').on(t.userId, t.createdAt),
  ],
);

/** 云端阅读进度，按作品记录到章。 */
export const readingProgress = sqliteTable(
  'reading_progress',
  {
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    novelId: text()
      .notNull()
      .references(() => novels.id, { onDelete: 'cascade' }),
    chapterIndex: integer().notNull().default(1),
    /** 章内百分比 0–100，便于跨设备恢复到大致位置。 */
    percent: integer().notNull().default(0),
    updatedAt: ts().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.novelId] }),
    index('reading_progress_user_idx').on(t.userId, t.updatedAt),
  ],
);

/** 标签目录：归一化后的标签及其作品计数。 */
export const tags = sqliteTable(
  'tags',
  {
    /** 归一化后的键（小写、去空白、全角转半角）。 */
    slug: text().primaryKey(),
    /** 展示用的原始写法，取最常见的一种。 */
    label: text().notNull(),
    novelCount: integer().notNull().default(0),
    updatedAt: ts().notNull(),
  },
  (t) => [index('tags_count_idx').on(t.novelCount)],
);

export const novelTags = sqliteTable(
  'novel_tags',
  {
    novelId: text()
      .notNull()
      .references(() => novels.id, { onDelete: 'cascade' }),
    slug: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.novelId, t.slug] }), index('novel_tags_slug_idx').on(t.slug)],
);

/** 旧 @用户名 → 用户，用于改名后的 301 跳转。 */
export const handleHistory = sqliteTable(
  'handle_history',
  {
    handle: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    releasedAt: ts().notNull(),
  },
  (t) => [index('handle_history_user_idx').on(t.userId, t.releasedAt)],
);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type NovelRow = typeof novels.$inferSelect;
export type NovelVersionRow = typeof novelVersions.$inferSelect;
export type BlobRow = typeof blobs.$inferSelect;
export type VersionChapterRow = typeof versionChapters.$inferSelect;
export type ForkRow = typeof forks.$inferSelect;
export type ReportRow = typeof reports.$inferSelect;
export type FollowRow = typeof follows.$inferSelect;
export type BlockRow = typeof blocks.$inferSelect;
export type ActivityRow = typeof activities.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;
export type PointLedgerRow = typeof pointLedger.$inferSelect;
export type UserBadgeRow = typeof userBadges.$inferSelect;
export type EmailTokenRow = typeof emailTokens.$inferSelect;
export type ModerationEventRow = typeof moderationEvents.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type CommentLikeRow = typeof commentLikes.$inferSelect;
export type BookmarkRow = typeof bookmarks.$inferSelect;
export type ReadingProgressRow = typeof readingProgress.$inferSelect;
export type TagRow = typeof tags.$inferSelect;
export type NovelTagRow = typeof novelTags.$inferSelect;
export type HandleHistoryRow = typeof handleHistory.$inferSelect;
