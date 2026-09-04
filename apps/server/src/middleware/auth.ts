import type { MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppDeps, AppEnv, AuthUser } from '../context';
import { toAuthUser } from '../context';
import { sessions, users, type UserRow } from '../db/schema';
import { ApiError, unauthorized, forbidden } from '../lib/errors';
import { hashToken, isTokenShape } from '../lib/tokens';
import { DAY, HOUR } from '../lib/time';
import { recordModerationEvent } from '../modules/admin/audit';

export const SESSION_TTL_MS = 30 * DAY;
/** 距上次续期超过 1 小时才写库，避免每次请求都更新。 */
const RENEW_THRESHOLD_MS = HOUR;

/** 只读方法不受封禁影响：被封的人仍然可以看内容，只是不能写。 */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 账号状态守卫（P0-6）：banned、或 suspended 且未到解禁时间的账号，任何写请求一律 403。
 * suspendedUntil 已过期则就地恢复为 active 并记一条系统审计日志。
 */
export function enforceAccountStatus(deps: AppDeps, method: string, row: UserRow): UserRow {
  if (row.status === 'active') return row;
  const now = deps.clock.now();
  if (row.status === 'suspended' && row.suspendedUntil && row.suspendedUntil.getTime() <= now.getTime()) {
    deps.db.update(users).set({ status: 'active', suspendedUntil: null, statusReason: null, updatedAt: now }).where(eq(users.id, row.id)).run();
    recordModerationEvent(deps, { actorId: null, targetType: 'user', targetId: row.id, action: 'user_auto_unban', reason: '禁言到期自动恢复' });
    return { ...row, status: 'active', suspendedUntil: null, statusReason: null };
  }
  if (READ_METHODS.has(method)) return row;
  const until = row.status === 'suspended' && row.suspendedUntil ? `，解禁时间 ${row.suspendedUntil.toISOString()}` : '';
  const why = row.statusReason ? `：${row.statusReason}` : '';
  throw new ApiError('ACCOUNT_SUSPENDED', `${row.status === 'banned' ? '账号已被封禁' : '账号已被限期禁言'}${why}${until}`);
}

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
  if (row.user.deletedAt !== null) throw unauthorized('账号已注销');
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
  const userRow = enforceAccountStatus(deps, c.req.method, row.user);
  c.set('session', session);
  c.set('user', toAuthUser(userRow));
  c.set('viewerKey', `user:${userRow.id}`);
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
