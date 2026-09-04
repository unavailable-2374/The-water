import { z } from 'zod';

export const ErrorCodeSchema = z.enum([
  'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR', 'CONFLICT', 'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE', 'BLOBS_MISSING', 'HASH_MISMATCH', 'VERSION_NOT_DRAFT',
  'DERIVATIVES_NOT_ALLOWED', 'EMAIL_TAKEN', 'INVALID_CREDENTIALS', 'INTERNAL',
  'BLOCKED', 'HANDLE_TAKEN', 'STORAGE_QUOTA_EXCEEDED',
  /** 文本未通过内容审核（标题 / 摘要 / 标签 / 留言 / 昵称 / 简介）。 */
  'CONTENT_REJECTED',
  /** 账号被封禁或限期禁言，不能写入任何内容。 */
  'ACCOUNT_SUSPENDED',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ERROR_STATUS: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, VALIDATION_ERROR: 400, CONFLICT: 409,
  RATE_LIMITED: 429, PAYLOAD_TOO_LARGE: 413, BLOBS_MISSING: 409, HASH_MISMATCH: 400,
  VERSION_NOT_DRAFT: 409, DERIVATIVES_NOT_ALLOWED: 403, EMAIL_TAKEN: 409, INVALID_CREDENTIALS: 401,
  INTERNAL: 500, BLOCKED: 403, HANDLE_TAKEN: 409, STORAGE_QUOTA_EXCEEDED: 413,
  CONTENT_REJECTED: 400, ACCOUNT_SUSPENDED: 403,
};

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorSchema>;

export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}
export type Page<T> = { items: T[]; nextCursor: string | null };

export const CursorQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** 无返回体操作的统一响应。 */
export const OkResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponseSchema>;

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.string(),
  version: z.string(),
  time: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
