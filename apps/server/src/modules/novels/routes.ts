import { Hono } from 'hono';
import {
  CreateNovelRequestSchema,
  CursorQuerySchema,
  UpdateNovelRequestSchema,
  UpdateReadingProgressRequestSchema,
  type CreateNovelRequest,
  type UpdateNovelRequest,
  type UpdateReadingProgressRequest,
} from '@the-water/shared';
import type { z } from 'zod';
import type { AppDeps, AppEnv } from '../../context';
import { currentUser, requireAuth } from '../../middleware/auth';
import { keyByUser, rateLimit } from '../../middleware/rate-limit';
import { getValid, validate } from '../../middleware/validate';
import { buildAttribution } from './attribution';
import * as shelf from './shelf';
import * as svc from './service';

export function novelRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();

  const write = rateLimit(deps, 'write', keyByUser);
  const social = rateLimit(deps, 'social', keyByUser);

  r.post('/novels', requireAuth(), write, validate('json', CreateNovelRequestSchema), async (c) => {
    const body = getValid<CreateNovelRequest>(c, 'json');
    return c.json({ novel: await svc.createNovel(deps, currentUser(c), body) }, 201);
  });

  r.get('/me/novels', requireAuth(), validate('query', CursorQuerySchema), (c) => {
    const q = getValid<z.infer<typeof CursorQuerySchema>>(c, 'query');
    return c.json(svc.listMyNovels(deps, currentUser(c), q.cursor, q.limit));
  });

  // ---- 「想读」书架与阅读进度（§3.4）----

  r.get('/me/bookmarks', requireAuth(), validate('query', CursorQuerySchema), (c) => {
    const q = getValid<z.infer<typeof CursorQuerySchema>>(c, 'query');
    return c.json(shelf.listMyBookmarks(deps, currentUser(c), q.cursor, q.limit));
  });

  r.get('/me/progress', requireAuth(), validate('query', CursorQuerySchema), (c) => {
    const q = getValid<z.infer<typeof CursorQuerySchema>>(c, 'query');
    return c.json(shelf.listMyProgress(deps, currentUser(c), q.cursor, q.limit));
  });

  r.get('/novels/:id/bookmark', requireAuth(), (c) =>
    c.json({ bookmarked: shelf.isBookmarked(deps, currentUser(c).id, c.req.param('id')) }),
  );
  r.put('/novels/:id/bookmark', requireAuth(), social, (c) =>
    c.json(shelf.addBookmark(deps, currentUser(c), c.req.param('id'))),
  );
  r.delete('/novels/:id/bookmark', requireAuth(), social, (c) =>
    c.json(shelf.removeBookmark(deps, currentUser(c), c.req.param('id'))),
  );

  r.get('/novels/:id/progress', requireAuth(), (c) =>
    c.json({ progress: shelf.getProgress(deps, currentUser(c), c.req.param('id')) }),
  );
  r.put(
    '/novels/:id/progress',
    requireAuth(),
    social,
    validate('json', UpdateReadingProgressRequestSchema),
    (c) => {
      const body = getValid<UpdateReadingProgressRequest>(c, 'json');
      return c.json({ progress: shelf.saveProgress(deps, currentUser(c), c.req.param('id'), body) });
    },
  );

  // ---- 许可与署名（§3.7）----

  r.get('/novels/:id/attribution', (c) => {
    const viewer = c.get('user');
    const novel = svc.loadViewableNovel(deps, c.req.param('id'), viewer);
    return c.json({ attribution: buildAttribution(deps, novel, null, viewer) });
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
