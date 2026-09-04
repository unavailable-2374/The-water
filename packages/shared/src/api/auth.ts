import { z } from 'zod';
import { UserSchema } from '../novel';
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
