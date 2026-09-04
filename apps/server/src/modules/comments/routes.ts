import { Hono } from 'hono';
import {
  CreateCommentRequestSchema,
  CreateReportRequestSchema,
  CursorQuerySchema,
  type CreateCommentRequest,
} from '@the-water/shared';
import type { z } from 'zod';
import type { AppDeps, AppEnv } from '../../context';
import { currentUser, requireAuth } from '../../middleware/auth';
import { keyByUser, rateLimit } from '../../middleware/rate-limit';
import { getValid, validate } from '../../middleware/validate';
import { awardComment } from '../incentive/service';
import { toReport } from '../social/service';
import * as svc from './service';

export function commentRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();

  r.get('/novels/:id/comments', validate('query', CursorQuerySchema), (c) => {
    const q = getValid<z.infer<typeof CursorQuerySchema>>(c, 'query');
    return c.json(svc.listComments(deps, c.req.param('id'), c.get('user'), q.cursor, q.limit));
  });

  r.get('/novels/:id/comments/:cid/replies', validate('query', CursorQuerySchema), (c) => {
    const q = getValid<z.infer<typeof CursorQuerySchema>>(c, 'query');
    return c.json(svc.listReplies(deps, c.req.param('id'), c.req.param('cid'), c.get('user'), q.cursor, q.limit));
  });

  r.post('/novels/:id/comments', requireAuth(), rateLimit(deps, 'comment', keyByUser), validate('json', CreateCommentRequestSchema), (c) => {
    const body = getValid<CreateCommentRequest>(c, 'json');
    const comment = svc.createComment(deps, currentUser(c), c.req.param('id'), body, {
      onCommented: (tx, ctx) => awardComment(deps, tx, ctx),
    });
    return c.json({ comment }, 201);
  });

  r.delete('/novels/:id/comments/:cid', requireAuth(), (c) => {
    svc.deleteComment(deps, currentUser(c), c.req.param('id'), c.req.param('cid'));
    return c.json({ ok: true as const });
  });

  r.post('/novels/:id/comments/:cid/reports', validate('json', CreateReportRequestSchema), (c) => {
    const body = getValid<z.infer<typeof CreateReportRequestSchema>>(c, 'json');
    const row = svc.reportComment(deps, c.req.param('id'), c.req.param('cid'), c.get('user'), body);
    return c.json({ report: toReport(row) }, 201);
  });

  return r;
}
