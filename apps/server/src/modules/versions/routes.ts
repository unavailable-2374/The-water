import { Hono } from 'hono';
import type { z } from 'zod';
import { CreateVersionRequestSchema, CursorQuerySchema, type CreateVersionRequest } from '@the-water/shared';
import type { AppDeps, AppEnv } from '../../context';
import { validation } from '../../lib/errors';
import { currentUser, requireAuth } from '../../middleware/auth';
import { keyByUser, rateLimit } from '../../middleware/rate-limit';
import { getValid, validate } from '../../middleware/validate';
import * as svc from './service';

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export function versionRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  // §3.3：写端点统一挂限流。
  const write = rateLimit(deps, 'write', keyByUser);

  r.post('/novels/:id/versions', requireAuth(), write, validate('json', CreateVersionRequestSchema), async (c) => {
    const key = c.req.header('idempotency-key');
    if (!key || !IDEMPOTENCY_KEY_RE.test(key)) throw validation('缺少或无效的 Idempotency-Key 请求头');
    const body = getValid<CreateVersionRequest>(c, 'json');
    const { response, created } = await svc.createDraft(deps, currentUser(c), c.req.param('id'), key, body);
    return c.json(response, created ? 201 : 200);
  });

  r.get('/novels/:id/versions', validate('query', CursorQuerySchema), (c) => {
    const q = getValid<z.infer<typeof CursorQuerySchema>>(c, 'query');
    return c.json(svc.listVersions(deps, c.req.param('id'), c.get('user'), q.cursor, q.limit));
  });

  r.get('/novels/:id/versions/:vid', (c) => {
    return c.json(svc.getVersionStatus(deps, c.req.param('id'), c.req.param('vid'), c.get('user')));
  });

  r.delete('/novels/:id/versions/:vid', requireAuth(), write, (c) => {
    svc.abortDraft(deps, currentUser(c), c.req.param('id'), c.req.param('vid'));
    return c.json({ ok: true as const });
  });

  r.post('/novels/:id/versions/:vid/commit', requireAuth(), write, async (c) => {
    return c.json(await svc.commitVersion(deps, currentUser(c), c.req.param('id'), c.req.param('vid')));
  });

  return r;
}
