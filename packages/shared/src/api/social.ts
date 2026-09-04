import { z } from 'zod';
import { pageSchema, CursorQuerySchema } from './common';

export const LikeResponseSchema = z.object({ liked: z.boolean(), likeCount: z.number().int() });

export const ReportReasonSchema = z.enum(['plagiarism', 'illegal', 'adult', 'spam', 'other']);
export const CreateReportRequestSchema = z.object({
  reason: ReportReasonSchema,
  detail: z.string().max(1000).optional(),
});
export const ReportSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  /** 非空表示这是对某条评论的举报。 */
  commentId: z.string().nullable(),
  reporterId: z.string().nullable(),
  reason: ReportReasonSchema,
  detail: z.string().nullable(),
  status: z.enum(['open', 'resolved', 'dismissed']),
  createdAt: z.string(),
});
export const ModerationUpdateSchema = z.object({
  moderationStatus: z.enum(['ok', 'hidden', 'removed']),
  note: z.string().max(500).optional(),
  /** 下架时把该作品产生的积分按人冲正。 */
  reversePoints: z.boolean().optional(),
});

/** `POST /novels/:id/view`：counted 表示本次是否计入（每日每访客去重）。 */
export const ViewResponseSchema = z.object({ viewCount: z.number().int(), counted: z.boolean() });
export type ViewResponse = z.infer<typeof ViewResponseSchema>;

export const ReportResponseSchema = z.object({ report: ReportSchema });
export type ReportResponse = z.infer<typeof ReportResponseSchema>;

/** `GET /admin/reports` 的分页响应。 */
export const ReportListResponseSchema = pageSchema(ReportSchema);
export type ReportListResponse = z.infer<typeof ReportListResponseSchema>;

// ---- 审核后台（P0-6）----

/** 审计日志的一条记录。actorId 为空表示系统自动动作（如自动审核拦截）。 */
export const ModerationEventSchema = z.object({
  id: z.string(),
  actorId: z.string().nullable(),
  targetType: z.enum(['novel', 'version', 'comment', 'user', 'report']),
  targetId: z.string(),
  /** 见服务端 audit.ts 的动作取值表，如 novel_hide / user_ban / auto_reject。 */
  action: z.string(),
  reason: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
});
export type ModerationEvent = z.infer<typeof ModerationEventSchema>;

export const ModerationEventListResponseSchema = pageSchema(ModerationEventSchema);
export type ModerationEventListResponse = z.infer<typeof ModerationEventListResponseSchema>;

/** 管理端看到的用户视图，比公开的 UserCard 多出邮箱与账号状态。 */
export const AdminUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  handle: z.string(),
  displayName: z.string(),
  role: z.enum(['user', 'admin']),
  status: z.enum(['active', 'suspended', 'banned']),
  suspendedUntil: z.string().nullable(),
  statusReason: z.string().nullable(),
  createdAt: z.string(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const AdminUserResponseSchema = z.object({ user: AdminUserSchema });
export type AdminUserResponse = z.infer<typeof AdminUserResponseSchema>;

export const AdminUserListResponseSchema = pageSchema(AdminUserSchema);
export type AdminUserListResponse = z.infer<typeof AdminUserListResponseSchema>;

/** `POST /admin/users/:id/ban`：until 为空即永久封禁，有值则限期禁言。 */
export const BanUserRequestSchema = z.object({
  reason: z.string().min(1).max(500),
  until: z.string().datetime().optional(),
});
export type BanUserRequest = z.infer<typeof BanUserRequestSchema>;

/** `POST /admin/comments/:id/hide`：可选备注写进审计日志。 */
export const CommentModerationActionSchema = z.object({ note: z.string().max(500).optional() });

/** 举报记录（服务端 social/service.ts 的 Report 与此同形）。 */
export type Report = z.infer<typeof ReportSchema>;

// ---- 站内通知（§3.1）----

/**
 * 通知类型。title / body 由服务端在写入时渲染好（冗余存储），
 * 客户端只负责按 kind 选图标与跳转目标，不再回查关联对象。
 */
export const NOTIFICATION_KINDS = [
  'followed',
  'liked',
  'commented',
  'replied',
  'mentioned',
  'comment_liked',
  'forked',
  'badge',
  'moderation_novel',
  'moderation_comment',
] as const;
export const NotificationKindSchema = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

/** 触发者的最小名片；系统通知为 null。 */
export const NotificationActorSchema = z.object({
  id: z.string(),
  handle: z.string(),
  displayName: z.string(),
});
export type NotificationActor = z.infer<typeof NotificationActorSchema>;

export const NotificationSchema = z.object({
  id: z.string(),
  kind: NotificationKindSchema,
  /** 跳转目标的类型与 id：novel → 作品页，user → 作者主页，comment → 作品页留言区。 */
  refType: z.enum(['novel', 'user', 'comment', 'badge', 'system']),
  refId: z.string(),
  /** 主标题，服务端已渲染成完整中文句子。 */
  title: z.string(),
  /** 副文本（留言摘要 / 审核备注），可能为空串。 */
  body: z.string(),
  actor: NotificationActorSchema.nullable(),
  /** 点开留言类通知时要落到哪本书：refType='comment' 时非空。 */
  novelId: z.string().nullable(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Notification = z.infer<typeof NotificationSchema>;

export const NotificationQuerySchema = CursorQuerySchema.extend({
  /** unread 只返回未读。 */
  filter: z.enum(['all', 'unread']).default('all'),
});
export type NotificationQuery = z.infer<typeof NotificationQuerySchema>;

/** 列表响应顺带带上未读总数，省一次请求。 */
export const NotificationListResponseSchema = pageSchema(NotificationSchema).extend({
  unreadCount: z.number().int(),
});
export type NotificationListResponse = z.infer<typeof NotificationListResponseSchema>;

export const UnreadCountResponseSchema = z.object({ unreadCount: z.number().int() });
export type UnreadCountResponse = z.infer<typeof UnreadCountResponseSchema>;

/** 批量已读：给 ids 就只标这些，给 all=true 就全部标已读。两者都不给是参数错误。 */
export const MarkNotificationsReadRequestSchema = z
  .object({
    ids: z.array(z.string().max(64)).max(200).optional(),
    all: z.boolean().optional(),
  })
  .refine((v) => v.all === true || (v.ids?.length ?? 0) > 0, '要么给 ids，要么 all=true');
export type MarkNotificationsReadRequest = z.infer<typeof MarkNotificationsReadRequestSchema>;

export const MarkNotificationsReadResponseSchema = z.object({
  updated: z.number().int(),
  unreadCount: z.number().int(),
});
export type MarkNotificationsReadResponse = z.infer<typeof MarkNotificationsReadResponseSchema>;
