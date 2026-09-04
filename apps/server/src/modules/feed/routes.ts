import { Hono } from 'hono';
import { FoldedFeedQuerySchema, type FoldedFeedQuery } from '@the-water/shared';
import type { AppDeps, AppEnv } from '../../context';
import { getValid, validate } from '../../middleware/validate';
import * as svc from './service';

export function feedRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();

  // 默认折叠（同一本书只出一条）；?collapse=false 拿回逐条的原始动态。
  r.get('/feed', validate('query', FoldedFeedQuerySchema), (c) => {
    return c.json(svc.listFeed(deps, c.get('user'), getValid<FoldedFeedQuery>(c, 'query')));
  });

  return r;
}
