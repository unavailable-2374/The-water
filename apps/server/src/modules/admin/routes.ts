import { Hono } from 'hono';
import { z } from 'zod';
import {
  BanUserRequestSchema,
  CommentModerationActionSchema,
  CommentModerationSchema,
  CursorQuerySchema,
  ModerationUpdateSchema,
} from '@the-water/shared';
import type { AppDeps, AppEnv } from '../../context';
import { currentUser, requireAdmin } from '../../middleware/auth';
import { getValid, validate } from '../../middleware/validate';
import * as svc from './service';

const ReportsQuerySchema = CursorQuerySchema.extend({ status: z.enum(['open', 'resolved', 'dismissed']).optional() });
const ResolveReportSchema = z.object({ status: z.enum(['resolved', 'dismissed']), note: z.string().max(500).optional() });
const UsersQuerySchema = CursorQuerySchema.extend({
  q: z.string().max(120).optional(),
  status: z.enum(['active', 'suspended', 'banned']).optional(),
});
const EventsQuerySchema = CursorQuerySchema.extend({
  targetType: z.enum(['novel', 'version', 'comment', 'user', 'report']).optional(),
  targetId: z.string().max(64).optional(),
  actorId: z.string().max(64).optional(),
  action: z.string().max(40).optional(),
});

/** 这些动作的请求体只有一个可选备注，允许完全不带 body。 */
async function noteOf(c: { req: { header(k: string): string | undefined; json(): Promise<unknown> } }): Promise<string | undefined> {
  if (!(c.req.header('content-type') ?? '').includes('application/json')) return undefined;
  try {
    const parsed = CommentModerationActionSchema.safeParse(await c.req.json());
    return parsed.success ? parsed.data.note : undefined;
  } catch {
    return undefined;
  }
}

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

  // 留言处理的简写入口：只给留言 id，作品 id 从库里取。
  r.post('/admin/comments/:id/hide', async (c) => {
    return c.json({ comment: svc.setCommentModerationById(deps, currentUser(c), c.req.param('id'), 'hidden', await noteOf(c)) });
  });

  r.post('/admin/comments/:id/restore', async (c) => {
    return c.json({ comment: svc.setCommentModerationById(deps, currentUser(c), c.req.param('id'), 'ok', await noteOf(c)) });
  });

  r.patch('/admin/reports/:id', validate('json', ResolveReportSchema), (c) => {
    const body = getValid<z.infer<typeof ResolveReportSchema>>(c, 'json');
    return c.json({ report: svc.resolveReport(deps, currentUser(c), c.req.param('id'), body.status, body.note) });
  });

  r.get('/admin/users', validate('query', UsersQuerySchema), (c) => {
    const q = getValid<z.infer<typeof UsersQuerySchema>>(c, 'query');
    return c.json(svc.listUsers(deps, q));
  });

  r.post('/admin/users/:id/ban', validate('json', BanUserRequestSchema), (c) => {
    const body = getValid<z.infer<typeof BanUserRequestSchema>>(c, 'json');
    return c.json({ user: svc.banUser(deps, currentUser(c), c.req.param('id'), body.reason, body.until) });
  });

  r.post('/admin/users/:id/unban', async (c) => {
    return c.json({ user: svc.unbanUser(deps, currentUser(c), c.req.param('id'), await noteOf(c)) });
  });

  r.get('/admin/moderation-events', validate('query', EventsQuerySchema), (c) => {
    const q = getValid<z.infer<typeof EventsQuerySchema>>(c, 'query');
    return c.json(svc.listModerationEvents(deps, q, q.cursor, q.limit));
  });

  return r;
}
