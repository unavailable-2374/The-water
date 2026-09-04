import { Hono } from 'hono';
import {
  CursorQuerySchema,
  UserNovelsQuerySchema,
  UserSearchQuerySchema,
  type UserNovelsQuery,
  type UserSearchQuery,
} from '@the-water/shared';
import type { z } from 'zod';
import type { AppDeps, AppEnv } from '../../context';
import { currentUser, requireAuth } from '../../middleware/auth';
import { keyByUser, rateLimit } from '../../middleware/rate-limit';
import { getValid, validate } from '../../middleware/validate';
import * as svc from './service';

export function userRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const social = rateLimit(deps, 'social', keyByUser);

  // 用户搜索（§3.4）。静态路径，不会和 /users/:id 冲突。
  r.get('/users', validate('query', UserSearchQuerySchema), (c) => {
    return c.json(svc.searchUsers(deps, c.get('user'), getValid<UserSearchQuery>(c, 'query')));
  });

  r.get('/users/by-handle/:handle', (c) => {
    return c.json({ user: svc.getUserProfileByHandle(deps, c.req.param('handle'), c.get('user')) });
  });

  r.get('/users/:id', (c) => {
    return c.json({ user: svc.getUserProfile(deps, c.req.param('id'), c.get('user')) });
  });

  r.get('/users/:id/novels', validate('query', UserNovelsQuerySchema), (c) => {
    const q = getValid<UserNovelsQuery>(c, 'query');
    return c.json(svc.listUserNovels(deps, c.req.param('id'), c.get('user'), q));
  });

  r.put('/users/:id/follow', requireAuth(), social, (c) => c.json(svc.follow(deps, currentUser(c), c.req.param('id'))));
  r.delete('/users/:id/follow', requireAuth(), social, (c) => c.json(svc.unfollow(deps, currentUser(c), c.req.param('id'))));
  r.put('/users/:id/block', requireAuth(), social, (c) => c.json(svc.block(deps, currentUser(c), c.req.param('id'))));
  r.delete('/users/:id/block', requireAuth(), social, (c) => c.json(svc.unblock(deps, currentUser(c), c.req.param('id'))));

  for (const which of ['following', 'followers', 'blocks'] as const) {
    r.get(`/me/${which}`, requireAuth(), validate('query', CursorQuerySchema), (c) => {
      const q = getValid<z.infer<typeof CursorQuerySchema>>(c, 'query');
      return c.json(svc.listRelations(deps, currentUser(c), which, q.cursor, q.limit));
    });
  }

  return r;
}
