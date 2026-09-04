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
