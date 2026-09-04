import type { MiddlewareHandler } from 'hono';
import { getConnInfo } from 'hono/bun';
import type { AppEnv } from '../context';
import type { Env } from '../env';

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * IP 前缀：IPv4 取前三段、IPv6 取前四组。X-Client-Id 由客户端自报，单独用它来去重
 * 等于把展示数交给刷子；绑定一个 IP 前缀后，轮换 client id 至少要换网段才有效（§3.3）。
 */
export function ipPrefix(ip: string): string {
  if (ip === 'unknown') return 'unknown';
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':');
  const parts = ip.split('.');
  return parts.length === 4 ? parts.slice(0, 3).join('.') : ip;
}

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
  c.set('viewerKey', cid && CLIENT_ID_RE.test(cid) ? `client:${cid}@${ipPrefix(ip)}` : `ip:${ip}`);
  await next();
};
