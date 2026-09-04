import { Hono } from 'hono';
import { z } from 'zod';
import { CommentModerationSchema, CursorQuerySchema, ModerationUpdateSchema } from '@the-water/shared';
import type { AppDeps, AppEnv } from '../../context';
import { currentUser, requireAdmin } from '../../middleware/auth';
import { getValid, validate } from '../../middleware/validate';
import * as svc from './service';

const ReportsQuerySchema = CursorQuerySchema.extend({ status: z.enum(['open', 'resolved', 'dismissed']).optional() });
const ResolveReportSchema = z.object({ status: z.enum(['resolved', 'dismissed']), note: z.string().max(500).optional() });

export function adminRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  r.use('/admin/*', requireAdmin());

  r.get('/admin/reports', validate('query', ReportsQuerySchema), (c) => {
    const q = getValid<z.infer<typeof ReportsQuerySchema>>(c, 'query');
    return c.json(svc.listReports(deps, q.status, q.cursor, q.limit));
  });

  r.patch('/admin/novels/:id/moderation', validate('json', ModerationUpdateSchema), (c) => {
    const body = getValid<z.infer<typeof ModerationUpdateSchema>>(c, 'json');
    return c.json({ novel: svc.setModeration(deps, currentUser(c), c.req.param('id'), body.moderationStatus, body.note, body.reversePoints) });
  });

  r.patch('/admin/novels/:id/comments/:cid', validate('json', CommentModerationSchema), (c) => {
    const body = getValid<z.infer<typeof CommentModerationSchema>>(c, 'json');
    return c.json({ comment: svc.setCommentModeration(deps, currentUser(c), c.req.param('id'), c.req.param('cid'), body.status) });
  });

  r.patch('/admin/reports/:id', validate('json', ResolveReportSchema), (c) => {
    const body = getValid<z.infer<typeof ResolveReportSchema>>(c, 'json');
    return c.json({ report: svc.resolveReport(deps, c.req.param('id'), body.status, body.note) });
  });

  return r;
}
