import { z } from 'zod';
import { pageSchema } from './common';

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
