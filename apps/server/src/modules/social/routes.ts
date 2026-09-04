import { Hono } from 'hono';
import type { z } from 'zod';
import { CreateReportRequestSchema, CursorQuerySchema } from '@the-water/shared';
import type { AppDeps, AppEnv } from '../../context';
import { currentUser, requireAuth } from '../../middleware/auth';
import { getValid, validate } from '../../middleware/validate';
import * as svc from './service';

export function socialRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();

  r.put('/novels/:id/like', requireAuth(), (c) => c.json(svc.like(deps, currentUser(c), c.req.param('id'))));
  r.delete('/novels/:id/like', requireAuth(), (c) => c.json(svc.unlike(deps, currentUser(c), c.req.param('id'))));

  r.get('/me/likes', requireAuth(), validate('query', CursorQuerySchema), (c) => {
    const q = getValid<z.infer<typeof CursorQuerySchema>>(c, 'query');
    return c.json(svc.listMyLikes(deps, currentUser(c), q.cursor, q.limit));
  });

  r.post('/novels/:id/view', (c) => {
    return c.json(svc.recordView(deps, c.req.param('id'), c.get('viewerKey'), c.get('user')));
  });

  r.post('/novels/:id/reports', validate('json', CreateReportRequestSchema), (c) => {
    const body = getValid<z.infer<typeof CreateReportRequestSchema>>(c, 'json');
    return c.json({ report: svc.createReport(deps, c.req.param('id'), c.get('user'), body) }, 201);
  });

  return r;
}
