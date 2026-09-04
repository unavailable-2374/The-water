import { Hono } from 'hono';
import {
  LoginRequestSchema,
  RegisterRequestSchema,
  UpdateProfileRequestSchema,
  type LoginRequest,
  type RegisterRequest,
} from '@the-water/shared';
import type { z } from 'zod';
import type { AppDeps, AppEnv } from '../../context';
import { currentUser, requireAuth } from '../../middleware/auth';
import { keyByIp, rateLimit } from '../../middleware/rate-limit';
import { getValid, validate } from '../../middleware/validate';
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

  r.delete('/auth/sessions', requireAuth(), (c) => {
    svc.revokeAllSessions(deps, currentUser(c));
    return c.json({ ok: true as const });
  });

  r.get('/auth/me', requireAuth(), (c) => {
    return c.json({ user: svc.toUserDto(currentUser(c), { includeEmail: true }) });
  });

  r.patch('/auth/me', requireAuth(), validate('json', UpdateProfileRequestSchema), (c) => {
    const patch = getValid<z.infer<typeof UpdateProfileRequestSchema>>(c, 'json');
    const user = svc.updateProfile(deps, currentUser(c), patch);
    return c.json({ user: svc.toUserDto(user, { includeEmail: true }) });
  });

  return r;
}
