import { and, eq, lt } from 'drizzle-orm';
import { fallbackHandle, type AuthResponse, type LoginRequest, type RegisterRequest, type User } from '@the-water/shared';
import type { AppDeps, AuthUser } from '../../context';
import { changes } from '../../db/client';
import { toAuthUser } from '../../context';
import { sessions, users, type SessionRow, type UserRow } from '../../db/schema';
import { ApiError, notFound } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { generateToken, hashPassword, hashToken, verifyPassword } from '../../lib/tokens';
import { iso } from '../../lib/time';
import { SESSION_TTL_MS } from '../../middleware/auth';
import { moderateProfileFields, recordHandleChange } from '../users/service';

export function toUserDto(u: AuthUser, opts: { includeEmail: boolean }): User {
  return {
    id: u.id,
    ...(opts.includeEmail ? { email: u.email } : {}),
    handle: u.handle,
    displayName: u.displayName,
    bio: u.bio,
    role: u.role,
    createdAt: iso(u.createdAt),
  };
}

/**
 * ADMIN_EMAILS 提权的判定（P0-3）：邮箱已验证 **且** 在名单里才算管理员。
 * 未验证的邮箱抢注拿不到 admin，从名单移除后下次登录会自动降级。
 */
function roleFor(deps: AppDeps, email: string, emailVerifiedAt: Date | null): 'user' | 'admin' {
  return emailVerifiedAt !== null && deps.env.adminEmails.includes(email) ? 'admin' : 'user';
}

/**
 * 按 ADMIN_EMAILS 同步一次角色（升 / 降都做），返回同步后的行。
 * ADMIN_EMAILS 为空时完全不动 role，把授权权交给 `bun run admin:grant`；
 * 名单非空时它就是权威来源，CLI 授予的管理员如果不在名单里会在下次登录被降级。
 */
export function syncAdminRole(deps: AppDeps, row: UserRow): UserRow {
  if (deps.env.adminEmails.length === 0) return row;
  const role = roleFor(deps, row.email, row.emailVerifiedAt);
  if (role === row.role) return row;
  deps.db.update(users).set({ role, updatedAt: deps.clock.now() }).where(eq(users.id, row.id)).run();
  return { ...row, role };
}

/** 账号不存在时也要跑一次同参数的 argon2，避免用耗时探测邮箱是否注册过（§3.6）。 */
const dummyHashes = new Map<string, Promise<string>>();
function dummyPasswordHash(deps: AppDeps): Promise<string> {
  const key = `${deps.env.passwordMemoryCost}:${deps.env.passwordTimeCost}`;
  let p = dummyHashes.get(key);
  if (!p) {
    p = hashPassword(deps.env, 'the-water-constant-time-placeholder');
    dummyHashes.set(key, p);
  }
  return p;
}

function handleTaken(deps: AppDeps, handle: string, exceptUserId?: string): boolean {
  const row = deps.db.select({ id: users.id }).from(users).where(eq(users.handle, handle)).get();
  return !!row && row.id !== exceptUserId;
}

/**
 * 未指定用户名时按 id 生成 `u_xxxxxxxxxxxx`；万一撞了就追加计数后缀。
 * 指定了则必须没人用过（schema 已保证格式与保留字）。
 */
function resolveHandle(deps: AppDeps, userId: string, requested: string | undefined): string {
  if (requested) {
    if (handleTaken(deps, requested)) throw new ApiError('HANDLE_TAKEN', '这个用户名已经有人用了');
    return requested;
  }
  const base = fallbackHandle(userId);
  if (!handleTaken(deps, base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base.slice(0, 17)}${i}`;
    if (!handleTaken(deps, candidate)) return candidate;
  }
  throw new ApiError('HANDLE_TAKEN', '无法生成用户名，请手动指定');
}

async function issueSession(deps: AppDeps, user: AuthUser, clientLabel: string | undefined): Promise<AuthResponse> {
  const now = deps.clock.now();
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  deps.db
    .insert(sessions)
    .values({
      id: newId(),
      userId: user.id,
      tokenHash: await hashToken(token),
      clientLabel: clientLabel ?? null,
      createdAt: now,
      lastUsedAt: now,
      expiresAt,
    })
    .run();
  return { user: toUserDto(user, { includeEmail: true }), token, expiresAt: iso(expiresAt) };
}

export async function register(deps: AppDeps, req: RegisterRequest): Promise<AuthResponse> {
  const email = req.email.trim().toLowerCase();
  const existing = deps.db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
  if (existing) throw new ApiError('EMAIL_TAKEN', '该邮箱已注册');
  const now = deps.clock.now();
  const id = newId();
  const row = {
    id,
    email,
    handle: resolveHandle(deps, id, req.handle),
    passwordHash: await hashPassword(deps.env, req.password),
    displayName: req.displayName,
    bio: null,
    // 注册时邮箱一定未验证，所以永远是 user；管理员靠邮箱验证后登录同步或 admin:grant 授予。
    role: 'user' as const,
    status: 'active' as const,
    suspendedUntil: null,
    statusReason: null,
    emailVerifiedAt: null,
    deletedAt: null,
    followerCount: 0,
    followingCount: 0,
    points: 0,
    createdAt: now,
    updatedAt: now,
  };
  try {
    deps.db.insert(users).values(row).run();
  } catch (e) {
    const msg = String(e);
    if (msg.includes('users_handle_uq')) throw new ApiError('HANDLE_TAKEN', '这个用户名已经有人用了');
    if (msg.includes('UNIQUE')) throw new ApiError('EMAIL_TAKEN', '该邮箱已注册');
    throw e;
  }
  return issueSession(deps, toAuthUser(row), req.clientLabel);
}

export async function login(deps: AppDeps, req: LoginRequest): Promise<AuthResponse> {
  const email = req.email.trim().toLowerCase();
  const row = deps.db.select().from(users).where(eq(users.email, email)).get();
  // 无账号 / 已注销也要验一次 dummy hash，保证恒定时间路径（§3.6 账号枚举）。
  const stored = row && row.deletedAt === null ? row.passwordHash : await dummyPasswordHash(deps);
  const ok = await verifyPassword(req.password, stored);
  if (!row || row.deletedAt !== null || !ok) throw new ApiError('INVALID_CREDENTIALS', '邮箱或密码错误');
  // 登录时按 ADMIN_EMAILS 同步一次角色（升 / 降都做）。
  return issueSession(deps, toAuthUser(syncAdminRole(deps, row)), req.clientLabel);
}

export function logout(deps: AppDeps, session: SessionRow): void {
  deps.db.delete(sessions).where(eq(sessions.id, session.id)).run();
}

export function revokeAllSessions(deps: AppDeps, user: AuthUser): number {
  const res = deps.db.delete(sessions).where(eq(sessions.userId, user.id)).run();
  return changes(res);
}

export async function updateProfile(
  deps: AppDeps,
  user: AuthUser,
  patch: { displayName?: string; handle?: string; bio?: string | null },
): Promise<AuthUser> {
  // P0-2：昵称 / 用户名 / 简介与正文走同一条审核通道。
  await moderateProfileFields(deps, patch, user.id);
  const set: Partial<typeof users.$inferInsert> = { updatedAt: deps.clock.now() };
  if (patch.displayName !== undefined) set.displayName = patch.displayName;
  if (patch.bio !== undefined) set.bio = patch.bio;
  if (patch.handle !== undefined && patch.handle !== user.handle) {
    if (handleTaken(deps, patch.handle, user.id)) throw new ApiError('HANDLE_TAKEN', '这个用户名已经有人用了');
    set.handle = patch.handle;
  }
  try {
    deps.db.update(users).set(set).where(eq(users.id, user.id)).run();
  } catch (e) {
    if (String(e).includes('users_handle_uq')) throw new ApiError('HANDLE_TAKEN', '这个用户名已经有人用了');
    throw e;
  }
  // §3.4：旧 @用户名进历史表，/u/:handle 据此做 301，旧链接不至于直接失效。
  if (set.handle !== undefined) recordHandleChange(deps, user.id, user.handle, set.handle);
  const row = deps.db.select().from(users).where(eq(users.id, user.id)).get();
  if (!row) throw notFound('用户');
  return toAuthUser(row);
}

/** 清理已过期会话（启动与定时任务调用）。 */
export function gcSessions(deps: AppDeps): number {
  const res = deps.db.delete(sessions).where(and(lt(sessions.expiresAt, deps.clock.now()))).run();
  return changes(res);
}
