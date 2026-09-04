import { Hono } from 'hono';
import { CursorQuerySchema, LeaderboardQuerySchema, type LeaderboardQuery } from '@the-water/shared';
import type { z } from 'zod';
import type { AppDeps, AppEnv } from '../../context';
import { currentUser, requireAuth } from '../../middleware/auth';
import { getValid, validate } from '../../middleware/validate';
import { LeaderboardCache } from './service';
import * as svc from './service';

export function incentiveRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  // 缓存活在这个闭包里，因此每个 app 实例（含每个测试）互不影响。
  const cache = new LeaderboardCache();

  r.get('/me/points', requireAuth(), validate('query', CursorQuerySchema), (c) => {
    const q = getValid<z.infer<typeof CursorQuerySchema>>(c, 'query');
    return c.json(svc.myPoints(deps, currentUser(c), q.cursor, q.limit));
  });

  r.get('/leaderboard', validate('query', LeaderboardQuerySchema), (c) => {
    return c.json(cache.get(deps, getValid<LeaderboardQuery>(c, 'query')));
  });

  return r;
}
