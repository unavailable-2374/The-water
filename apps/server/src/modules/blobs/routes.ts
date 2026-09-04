import { Hono } from 'hono';
import { UploadBlobsRequestSchema, type UploadBlobsRequest } from '@the-water/shared';
import type { AppDeps, AppEnv } from '../../context';
import { currentUser, requireAuth } from '../../middleware/auth';
import { keyByUser, rateLimit } from '../../middleware/rate-limit';
import { getValid, validate } from '../../middleware/validate';
import * as svc from './service';

export function blobRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  r.post('/blobs', requireAuth(), rateLimit(deps, 'blobs', keyByUser), validate('json', UploadBlobsRequestSchema), async (c) => {
    const body = getValid<UploadBlobsRequest>(c, 'json');
    return c.json(await svc.uploadBlobs(deps, currentUser(c), body));
  });
  return r;
}
