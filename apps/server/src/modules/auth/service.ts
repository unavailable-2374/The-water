import { and, eq, lt } from 'drizzle-orm';
import { fallbackHandle, type AuthResponse, type LoginRequest, type RegisterRequest, type User } from '@the-water/shared';
import type { AppDeps, AuthUser } from '../../context';
import { changes } from '../../db/client';
import { toAuthUser } from '../../context';
import { sessions, users, type SessionRow } from '../../db/schema';
import { ApiError, notFound } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { generateToken, hashPassword, hashToken, verifyPassword } from '../../lib/tokens';
import { iso } from '../../lib/time';
import { SESSION_TTL_MS } from '../../middleware/auth';

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

function roleFor(deps: AppDeps, email: string): 'user' | 'admin' {
  return deps.env.adminEmails.includes(email) ? 'admin' : 'user';
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
    role: roleFor(deps, email),
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
  const ok = row ? await verifyPassword(req.password, row.passwordHash) : false;
  if (!row || !ok) throw new ApiError('INVALID_CREDENTIALS', '邮箱或密码错误');
  // 登录时同步管理员名单。
  const role = roleFor(deps, email);
  if (role === 'admin' && row.role !== 'admin') {
    deps.db.update(users).set({ role, updatedAt: deps.clock.now() }).where(eq(users.id, row.id)).run();
    row.role = 'admin';
  }
  return issueSession(deps, toAuthUser(row), req.clientLabel);
}

export function logout(deps: AppDeps, session: SessionRow): void {
  deps.db.delete(sessions).where(eq(sessions.id, session.id)).run();
}

export function revokeAllSessions(deps: AppDeps, user: AuthUser): number {
  const res = deps.db.delete(sessions).where(eq(sessions.userId, user.id)).run();
  return changes(res);
}

export function updateProfile(
  deps: AppDeps,
  user: AuthUser,
  patch: { displayName?: string; handle?: string; bio?: string | null },
): AuthUser {
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
  const row = deps.db.select().from(users).where(eq(users.id, user.id)).get();
  if (!row) throw notFound('用户');
  return toAuthUser(row);
}

/** 清理已过期会话（启动与定时任务调用）。 */
export function gcSessions(deps: AppDeps): number {
  const res = deps.db.delete(sessions).where(and(lt(sessions.expiresAt, deps.clock.now()))).run();
  return changes(res);
}
