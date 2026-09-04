import type { MiddlewareHandler } from 'hono';
import { getConnInfo } from 'hono/bun';
import type { AppEnv } from '../context';
import type { Env } from '../env';

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** 解析客户端 IP 与匿名访客键。鉴权中间件之后会用 user 覆盖 viewerKey。 */
export const clientId = (env: Env): MiddlewareHandler<AppEnv> => async (c, next) => {
  let ip = 'unknown';
  if (env.trustProxy) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) ip = xff.split(',')[0]!.trim();
  }
  if (ip === 'unknown') {
    try {
      const info = getConnInfo(c);
      ip = info.remote.address ?? 'unknown';
    } catch {
      ip = 'unknown';
    }
  }
  c.set('ip', ip);
  const cid = c.req.header('x-client-id');
  c.set('viewerKey', cid && CLIENT_ID_RE.test(cid) ? `client:${cid}` : `ip:${ip}`);
  await next();
};
