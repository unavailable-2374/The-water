import { Hono } from 'hono';
import {
  CommentListQuerySchema,
  CreateCommentRequestSchema,
  CreateReportRequestSchema,
  CursorQuerySchema,
  UpdateCommentRequestSchema,
  type CommentListQuery,
  type CreateCommentRequest,
  type UpdateCommentRequest,
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

  r.get('/novels/:id/comments', validate('query', CommentListQuerySchema), (c) => {
    return c.json(svc.listComments(deps, c.req.param('id'), c.get('user'), getValid<CommentListQuery>(c, 'query')));
  });

  r.get('/novels/:id/comments/:cid/replies', validate('query', CursorQuerySchema), (c) => {
    const q = getValid<z.infer<typeof CursorQuerySchema>>(c, 'query');
    return c.json(svc.listReplies(deps, c.req.param('id'), c.req.param('cid'), c.get('user'), q.cursor, q.limit));
  });

  r.post('/novels/:id/comments', requireAuth(), rateLimit(deps, 'comment', keyByUser), validate('json', CreateCommentRequestSchema), async (c) => {
    const body = getValid<CreateCommentRequest>(c, 'json');
    const comment = await svc.createComment(deps, currentUser(c), c.req.param('id'), body, {
      onCommented: (tx, ctx) => awardComment(deps, tx, ctx),
    });
    return c.json({ comment }, 201);
  });

  // 编辑窗口 15 分钟内可改正文（§3.6），改动同样走内容审核。
  r.patch(
    '/novels/:id/comments/:cid',
    requireAuth(),
    rateLimit(deps, 'comment', keyByUser),
    validate('json', UpdateCommentRequestSchema),
    async (c) => {
      const body = getValid<UpdateCommentRequest>(c, 'json');
      const comment = await svc.updateComment(deps, currentUser(c), c.req.param('id'), c.req.param('cid'), body);
      return c.json({ comment });
    },
  );

  const social = rateLimit(deps, 'social', keyByUser);
  r.put('/novels/:id/comments/:cid/like', requireAuth(), social, (c) => {
    return c.json(svc.likeComment(deps, currentUser(c), c.req.param('id'), c.req.param('cid'), true));
  });
  r.delete('/novels/:id/comments/:cid/like', requireAuth(), social, (c) => {
    return c.json(svc.likeComment(deps, currentUser(c), c.req.param('id'), c.req.param('cid'), false));
  });

  r.delete('/novels/:id/comments/:cid', requireAuth(), (c) => {
    svc.deleteComment(deps, currentUser(c), c.req.param('id'), c.req.param('cid'));
    return c.json({ ok: true as const });
  });

  // 与作品举报一致：要求登录 + 限流 + 同人同对象去重。
  r.post('/novels/:id/comments/:cid/reports', requireAuth(), rateLimit(deps, 'report', keyByUser), validate('json', CreateReportRequestSchema), (c) => {
    const body = getValid<z.infer<typeof CreateReportRequestSchema>>(c, 'json');
    const row = svc.reportComment(deps, c.req.param('id'), c.req.param('cid'), currentUser(c), c.get('viewerKey'), body);
    return c.json({ report: toReport(row) }, 201);
  });

  return r;
}
