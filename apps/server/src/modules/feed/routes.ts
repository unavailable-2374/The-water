import { Hono } from 'hono';
import { FeedQuerySchema, type FeedQuery } from '@the-water/shared';
import type { AppDeps, AppEnv } from '../../context';
import { getValid, validate } from '../../middleware/validate';
import * as svc from './service';

export function feedRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();

  r.get('/feed', validate('query', FeedQuerySchema), (c) => {
    return c.json(svc.listFeed(deps, c.get('user'), getValid<FeedQuery>(c, 'query')));
  });

  return r;
}
