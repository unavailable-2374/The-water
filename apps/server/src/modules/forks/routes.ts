import { Hono } from 'hono';
import { z } from 'zod';
import { CreateForkRequestSchema, CursorQuerySchema } from '@the-water/shared';
import type { AppDeps, AppEnv } from '../../context';
import { currentUser, requireAuth } from '../../middleware/auth';
import { keyByUser, rateLimit } from '../../middleware/rate-limit';
import { getValid, validate } from '../../middleware/validate';
import { buildBundle } from './bundle';
import { buildLineage } from './lineage';
import * as svc from './service';

const BundleQuerySchema = z.object({ forkId: z.string().max(64).optional() });

export function forkRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();

  // fork 幂等 + 限流，避免单账号循环刷 forkCount 与徽章（§3.3）。
  r.post('/novels/:id/forks', requireAuth(), rateLimit(deps, 'fork', keyByUser), validate('json', CreateForkRequestSchema), (c) => {
    const body = getValid<z.infer<typeof CreateForkRequestSchema>>(c, 'json');
    return c.json({ fork: svc.createFork(deps, currentUser(c), c.req.param('id'), body.versionId) }, 201);
  });

  r.get('/novels/:id/versions/:vid/bundle', validate('query', BundleQuerySchema), (c) => {
    const q = getValid<z.infer<typeof BundleQuerySchema>>(c, 'query');
    return c.json(buildBundle(deps, c.req.param('id'), c.req.param('vid'), c.get('user'), q.forkId));
  });

  r.get('/me/forks', requireAuth(), validate('query', CursorQuerySchema), (c) => {
    const q = getValid<z.infer<typeof CursorQuerySchema>>(c, 'query');
    return c.json(svc.listMyForks(deps, currentUser(c), q.cursor, q.limit));
  });

  r.get('/novels/:id/lineage', (c) => {
    return c.json(buildLineage(deps, c.req.param('id'), c.get('user')));
  });

  return r;
}
