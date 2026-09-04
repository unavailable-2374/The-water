import type { MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppDeps, AppEnv, AuthUser } from '../context';
import { toAuthUser } from '../context';
import { sessions, users } from '../db/schema';
import { unauthorized, forbidden } from '../lib/errors';
import { hashToken, isTokenShape } from '../lib/tokens';
import { DAY, HOUR } from '../lib/time';

export const SESSION_TTL_MS = 30 * DAY;
/** 距上次续期超过 1 小时才写库，避免每次请求都更新。 */
const RENEW_THRESHOLD_MS = HOUR;

/** 解析 Bearer token；无 token 时 user=null 继续，token 无效则 401。 */
export const authenticate = (deps: AppDeps): MiddlewareHandler<AppEnv> => async (c, next) => {
  c.set('user', null);
  c.set('session', null);
  const header = c.req.header('authorization');
  if (!header) return next();
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m || !isTokenShape(m[1]!)) throw unauthorized('登录凭证无效');
  const tokenHash = await hashToken(m[1]!);
  const now = deps.clock.now();
  const row = deps.db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, tokenHash))
    .get();
  if (!row) throw unauthorized('登录凭证无效');
  if (row.session.expiresAt.getTime() <= now.getTime()) {
    deps.db.delete(sessions).where(eq(sessions.id, row.session.id)).run();
    throw unauthorized('登录已过期');
  }
  let session = row.session;
  if (now.getTime() - session.lastUsedAt.getTime() >= RENEW_THRESHOLD_MS) {
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    deps.db.update(sessions).set({ lastUsedAt: now, expiresAt }).where(eq(sessions.id, session.id)).run();
    session = { ...session, lastUsedAt: now, expiresAt };
  }
  c.set('session', session);
  c.set('user', toAuthUser(row.user));
  c.set('viewerKey', `user:${row.user.id}`);
  await next();
};

export const requireAuth = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (!c.get('user')) throw unauthorized();
  await next();
};

export const requireAdmin = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const user = c.get('user');
  if (!user) throw unauthorized();
  if (user.role !== 'admin') throw forbidden('需要管理员权限');
  await next();
};

export function currentUser(c: { get: (k: 'user') => AuthUser | null }): AuthUser {
  const u = c.get('user');
  if (!u) throw unauthorized();
  return u;
}
