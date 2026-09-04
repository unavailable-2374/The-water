import { Hono } from 'hono';
import {
  ChangePasswordRequestSchema,
  DeleteAccountRequestSchema,
  ForgotPasswordRequestSchema,
  LoginRequestSchema,
  RegisterRequestSchema,
  ResetPasswordRequestSchema,
  UpdateProfileRequestSchema,
  VerifyEmailRequestSchema,
  type ChangePasswordRequest,
  type DeleteAccountRequest,
  type ForgotPasswordRequest,
  type LoginRequest,
  type RegisterRequest,
  type ResetPasswordRequest,
  type VerifyEmailRequest,
} from '@the-water/shared';
import type { z } from 'zod';
import type { AppDeps, AppEnv } from '../../context';
import { currentUser, requireAuth } from '../../middleware/auth';
import { keyByIp, rateLimit } from '../../middleware/rate-limit';
import { getValid, validate } from '../../middleware/validate';
import * as account from './account';
import * as svc from './service';

export function authRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();

  r.post('/auth/register', rateLimit(deps, 'register', keyByIp), validate('json', RegisterRequestSchema), async (c) => {
    const body = getValid<RegisterRequest>(c, 'json');
    return c.json(await svc.register(deps, body), 201);
  });

  r.post('/auth/login', rateLimit(deps, 'login', keyByIp), validate('json', LoginRequestSchema), async (c) => {
    const body = getValid<LoginRequest>(c, 'json');
    return c.json(await svc.login(deps, body));
  });

  r.post('/auth/logout', requireAuth(), (c) => {
    svc.logout(deps, c.get('session')!);
    return c.json({ ok: true as const });
  });

  // ---- 会话（登录设备）----

  r.get('/auth/sessions', requireAuth(), (c) => {
    return c.json({ sessions: account.listSessions(deps, currentUser(c), c.get('session')!) });
  });

  r.delete('/auth/sessions', requireAuth(), (c) => {
    svc.revokeAllSessions(deps, currentUser(c));
    return c.json({ ok: true as const });
  });

  r.delete('/auth/sessions/:id', requireAuth(), (c) => {
    account.revokeSession(deps, currentUser(c), c.req.param('id'));
    return c.json({ ok: true as const });
  });

  // ---- 个人资料 ----

  r.get('/auth/me', requireAuth(), (c) => {
    return c.json({ user: svc.toUserDto(currentUser(c), { includeEmail: true }) });
  });

  r.patch('/auth/me', requireAuth(), validate('json', UpdateProfileRequestSchema), async (c) => {
    const patch = getValid<z.infer<typeof UpdateProfileRequestSchema>>(c, 'json');
    const user = await svc.updateProfile(deps, currentUser(c), patch);
    return c.json({ user: svc.toUserDto(user, { includeEmail: true }) });
  });

  /** 数据导出：个人资料 + 自己全部作品的 bundle。 */
  r.get('/auth/me/export', requireAuth(), (c) => {
    return c.json(account.exportAccount(deps, currentUser(c)));
  });

  /** 注销账号：作品可选随账号下架或保留为匿名作者。 */
  r.delete('/auth/me', requireAuth(), rateLimit(deps, 'password', keyByIp), validate('json', DeleteAccountRequestSchema), async (c) => {
    await account.deleteAccount(deps, currentUser(c), getValid<DeleteAccountRequest>(c, 'json'));
    return c.json({ ok: true as const });
  });

  // ---- 邮箱验证 ----

  r.post('/auth/email/verify/request', requireAuth(), rateLimit(deps, 'password', keyByIp), async (c) => {
    await account.requestEmailVerification(deps, currentUser(c));
    return c.json({ ok: true as const }, 202);
  });

  r.post('/auth/email/verify', rateLimit(deps, 'password', keyByIp), validate('json', VerifyEmailRequestSchema), async (c) => {
    const user = await account.verifyEmail(deps, getValid<VerifyEmailRequest>(c, 'json').token);
    return c.json({ user: svc.toUserDto(user, { includeEmail: true }) });
  });

  // ---- 密码 ----

  /** 无论邮箱是否注册过都返回 202，不泄露账号是否存在。 */
  r.post('/auth/password/forgot', rateLimit(deps, 'password', keyByIp), validate('json', ForgotPasswordRequestSchema), async (c) => {
    await account.requestPasswordReset(deps, getValid<ForgotPasswordRequest>(c, 'json').email);
    return c.json({ ok: true as const }, 202);
  });

  r.post('/auth/password/reset', rateLimit(deps, 'password', keyByIp), validate('json', ResetPasswordRequestSchema), async (c) => {
    const body = getValid<ResetPasswordRequest>(c, 'json');
    await account.resetPassword(deps, body.token, body.password);
    return c.json({ ok: true as const });
  });

  r.patch('/auth/password', requireAuth(), rateLimit(deps, 'password', keyByIp), validate('json', ChangePasswordRequestSchema), async (c) => {
    await account.changePassword(deps, currentUser(c), c.get('session')!, getValid<ChangePasswordRequest>(c, 'json'));
    return c.json({ ok: true as const });
  });

  return r;
}
