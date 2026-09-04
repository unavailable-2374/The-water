import { z } from 'zod';
import { UserSchema } from '../novel';
import { NovelBundleV1Schema } from '../bundle';
import { HandleSchema } from '../community';
import { LIMITS } from '../constants';

export const RegisterRequestSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
  displayName: z.string().trim().min(1).max(32),
  handle: HandleSchema.optional(),
  clientLabel: z.string().max(100).optional(),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
  clientLabel: z.string().max(100).optional(),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const AuthResponseSchema = z.object({
  user: UserSchema,
  token: z.string(),
  expiresAt: z.string(),
});
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

export const MeResponseSchema = z.object({ user: UserSchema });

export const UpdateProfileRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(32).optional(),
  handle: HandleSchema.optional(),
  bio: z.string().max(LIMITS.BIO_MAX).nullable().optional(),
});
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>;

// ---- 账号生命周期（P0-4）----

/** 邮件里的令牌形如 `tw_` + 43 字符 base64url。 */
export const EmailTokenSchema = z.string().min(1).max(200);

export const VerifyEmailRequestSchema = z.object({ token: EmailTokenSchema });
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>;

export const ForgotPasswordRequestSchema = z.object({ email: z.string().email().max(254) });
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

export const ResetPasswordRequestSchema = z.object({
  token: EmailTokenSchema,
  password: z.string().min(8).max(128),
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

/** 注销账号：keep_works 保留作品并把作者显示为已注销，delete_works 同时下架全部作品。 */
export const DeleteAccountModeSchema = z.enum(['keep_works', 'delete_works']);
export const DeleteAccountRequestSchema = z.object({
  password: z.string().min(1).max(128),
  mode: DeleteAccountModeSchema,
});
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequestSchema>;

/** 登录设备列表的一项；current 标出发起这次请求的会话。 */
export const SessionSummarySchema = z.object({
  id: z.string(),
  clientLabel: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  expiresAt: z.string(),
  current: z.boolean(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const SessionListResponseSchema = z.object({ sessions: z.array(SessionSummarySchema) });
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;

/** 数据导出：个人资料 + 自己全部作品的 bundle；过大或无已提交版本的作品进 skipped。 */
export const AccountExportResponseSchema = z.object({
  exportedAt: z.string(),
  profile: UserSchema,
  novels: z.array(NovelBundleV1Schema),
  skipped: z.array(z.object({ novelId: z.string(), title: z.string(), reason: z.string() })),
});
export type AccountExportResponse = z.infer<typeof AccountExportResponseSchema>;
