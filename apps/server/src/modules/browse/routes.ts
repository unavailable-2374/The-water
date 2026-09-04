import { Hono } from 'hono';
import { BrowseQuerySchema, ChaptersQuerySchema, type BrowseQuery } from '@the-water/shared';
import type { z } from 'zod';
import type { AppDeps, AppEnv } from '../../context';
import { validation } from '../../lib/errors';
import { getValid, validate } from '../../middleware/validate';
import * as svc from './service';

export function parseIndex(raw: string): number {
  if (!/^\d{1,4}$/.test(raw)) throw validation('章节序号无效');
  return Number(raw);
}

export function browseRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();

  r.get('/novels', validate('query', BrowseQuerySchema), (c) => {
    return c.json(svc.browseNovels(deps, getValid<BrowseQuery>(c, 'query'), c.get('user')));
  });

  r.get('/novels/:id/versions/:vid/storyline', (c) => {
    return c.json(svc.getStoryline(deps, c.req.param('id'), c.req.param('vid'), c.get('user')));
  });

  r.get('/novels/:id/versions/:vid/chapters', validate('query', ChaptersQuerySchema), (c) => {
    const q = getValid<z.infer<typeof ChaptersQuerySchema>>(c, 'query');
    return c.json(svc.listChapters(deps, c.req.param('id'), c.req.param('vid'), c.get('user'), q.from, q.limit));
  });

  r.get('/novels/:id/versions/:vid/chapters/:index', (c) => {
    const index = parseIndex(c.req.param('index'));
    return c.json(svc.getChapter(deps, c.req.param('id'), c.req.param('vid'), index, c.get('user')));
  });

  return r;
}
