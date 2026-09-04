import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../context';
import { newId } from '../lib/ids';

export const requestId = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const id = incoming && /^[A-Za-z0-9_-]{1,64}$/.test(incoming) ? incoming : newId();
  c.set('requestId', id);
  c.header('X-Request-Id', id);
  await next();
  if (!c.res.headers.get('X-Request-Id')) c.res.headers.set('X-Request-Id', id);
};
