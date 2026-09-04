import { Hono } from 'hono';
import type { z } from 'zod';
import { CreateReportRequestSchema, CursorQuerySchema } from '@the-water/shared';
import type { AppDeps, AppEnv } from '../../context';
import { currentUser, requireAuth } from '../../middleware/auth';
import { keyByIp, keyByUser, rateLimit } from '../../middleware/rate-limit';
import { getValid, validate } from '../../middleware/validate';
import * as svc from './service';

export function socialRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();

  const social = rateLimit(deps, 'social', keyByUser);

  r.put('/novels/:id/like', requireAuth(), social, (c) => c.json(svc.like(deps, currentUser(c), c.req.param('id'))));
  r.delete('/novels/:id/like', requireAuth(), social, (c) => c.json(svc.unlike(deps, currentUser(c), c.req.param('id'))));

  r.get('/me/likes', requireAuth(), validate('query', CursorQuerySchema), (c) => {
    const q = getValid<z.infer<typeof CursorQuerySchema>>(c, 'query');
    return c.json(svc.listMyLikes(deps, currentUser(c), q.cursor, q.limit));
  });

  // 计浏览是匿名写端点，按 IP 限流兜底（§3.3）。
  r.post('/novels/:id/view', rateLimit(deps, 'read', keyByIp), (c) => {
    return c.json(svc.recordView(deps, c.req.param('id'), c.get('viewerKey'), c.get('user')));
  });

  // 举报要求登录并限流：匿名零成本举报可以直接刷爆审核队列（P0-6）。
  r.post('/novels/:id/reports', requireAuth(), rateLimit(deps, 'report', keyByUser), validate('json', CreateReportRequestSchema), (c) => {
    const body = getValid<z.infer<typeof CreateReportRequestSchema>>(c, 'json');
    return c.json({ report: svc.createReport(deps, c.req.param('id'), currentUser(c), c.get('viewerKey'), body) }, 201);
  });

  return r;
}
