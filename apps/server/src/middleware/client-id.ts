import type { MiddlewareHandler } from 'hono';
import { getConnInfo } from 'hono/bun';
import type { AppEnv } from '../context';
import type { Env } from '../env';
import { ipInList } from '../lib/net';

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

export interface ClientIpInput {
  /** TCP 直连来源。 */
  remote: string;
  /** 原始 X-Forwarded-For 头，没有则为 null。 */
  xff: string | null;
  trustProxy: boolean;
  trustedProxies: readonly string[];
}

/**
 * 解析真实客户端 IP（§4.5）。
 *
 * `X-Forwarded-For` 是任何人都能自己写的头，无条件取第一段等于把限流键、浏览去重键
 * 和封禁的判定都交给攻击方伪造。规则：
 * 1. `TRUST_PROXY=0`：完全不看 XFF，只认直连来源。
 * 2. `TRUST_PROXY=1` 且 `TRUSTED_PROXIES` 非空：直连来源必须命中名单才采信 XFF；
 *    采信时从**右往左**跳过名单里的地址，取第一个不在名单里的，也就是最靠近我们的那一跳
 *    真正写下的地址——它是唯一没法被更外层的客户端伪造的一段。
 * 3. `TRUST_PROXY=1` 但名单为空：退化成旧行为（取最左段）。这不安全，只为兼容既有部署保留，
 *    README 里标了「不推荐」。
 */
export function resolveClientIp(input: ClientIpInput): string {
  const { remote, xff, trustProxy, trustedProxies } = input;
  if (!trustProxy || !xff) return remote;
  const hops = xff
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!hops.length) return remote;
  if (trustedProxies.length === 0) return hops[0]!;
  if (remote === 'unknown' || !ipInList(remote, trustedProxies)) return remote;
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!ipInList(hops[i]!, trustedProxies)) return hops[i]!;
  }
  // 整条链都是自己的代理，那最左段就是客户端。
  return hops[0]!;
}

/** 解析客户端 IP 与匿名访客键。鉴权中间件之后会用 user 覆盖 viewerKey。 */
export const clientId =
  (env: Env): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    let remote = 'unknown';
    try {
      remote = getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      remote = 'unknown';
    }
    const ip = resolveClientIp({
      remote,
      xff: c.req.header('x-forwarded-for') ?? null,
      trustProxy: env.trustProxy,
      trustedProxies: env.trustedProxies,
    });
    c.set('ip', ip);
    const cid = c.req.header('x-client-id');
    c.set('viewerKey', cid && CLIENT_ID_RE.test(cid) ? `client:${cid}@${ipPrefix(ip)}` : `ip:${ip}`);
    await next();
  };
