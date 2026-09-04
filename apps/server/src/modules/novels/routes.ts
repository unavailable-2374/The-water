import { Hono } from 'hono';
import {
  CreateNovelRequestSchema,
  CursorQuerySchema,
  UpdateNovelRequestSchema,
  type CreateNovelRequest,
  type UpdateNovelRequest,
} from '@the-water/shared';
import type { z } from 'zod';
import type { AppDeps, AppEnv } from '../../context';
import { currentUser, requireAuth } from '../../middleware/auth';
import { keyByUser, rateLimit } from '../../middleware/rate-limit';
import { getValid, validate } from '../../middleware/validate';
import * as svc from './service';

export function novelRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();

  const write = rateLimit(deps, 'write', keyByUser);

  r.post('/novels', requireAuth(), write, validate('json', CreateNovelRequestSchema), async (c) => {
    const body = getValid<CreateNovelRequest>(c, 'json');
    return c.json({ novel: await svc.createNovel(deps, currentUser(c), body) }, 201);
  });

  r.get('/me/novels', requireAuth(), validate('query', CursorQuerySchema), (c) => {
    const q = getValid<z.infer<typeof CursorQuerySchema>>(c, 'query');
    return c.json(svc.listMyNovels(deps, currentUser(c), q.cursor, q.limit));
  });

  r.get('/novels/:id', (c) => {
    return c.json({ novel: svc.getNovelDetail(deps, c.req.param('id'), c.get('user')) });
  });

  r.patch('/novels/:id', requireAuth(), write, validate('json', UpdateNovelRequestSchema), async (c) => {
    const patch = getValid<UpdateNovelRequest>(c, 'json');
    return c.json({ novel: await svc.updateNovel(deps, currentUser(c), c.req.param('id'), patch) });
  });

  r.delete('/novels/:id', requireAuth(), write, (c) => {
    svc.deleteNovel(deps, currentUser(c), c.req.param('id'));
    return c.json({ ok: true as const });
  });

  return r;
}
