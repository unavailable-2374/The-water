/**
 * 账号生命周期（P0-4）：邮箱验证、找回密码、修改密码、注销账号、会话列表与数据导出。
 *
 * 令牌规则：明文只出现在邮件里，库里只存 sha256；verify 24 小时有效、reset 1 小时有效；
 * 用过即置 usedAt 不可复用；同一用户同 kind 新发时旧的立即作废。
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import type {
  AccountExportResponse,
  ChangePasswordRequest,
  DeleteAccountRequest,
  NovelBundleV1,
  SessionSummary,
} from '@the-water/shared';
import type { AppDeps, AuthUser } from '../../context';
import { changes } from '../../db/client';
import { toAuthUser } from '../../context';
import { emailTokens, novels, sessions, users, type SessionRow, type UserRow } from '../../db/schema';
import { ApiError, notFound, validation } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { generateToken, hashPassword, hashToken, isTokenShape, verifyPassword } from '../../lib/tokens';
import { HOUR, iso } from '../../lib/time';
import { buildBundle } from '../forks/bundle';
import { syncAdminRole, toUserDto } from './service';

type TokenKind = 'verify' | 'reset';

const TOKEN_TTL_MS: Record<TokenKind, number> = {
  verify: 24 * HOUR,
  reset: HOUR,
};

/** 注销后写入 passwordHash 的占位值：不是合法 argon2 串，任何密码都验不过。 */
const UNUSABLE_PASSWORD = '!注销账号不可登录';

// ---- 邮件令牌 ----

/** 发放令牌并作废该用户同类型的旧令牌；返回明文（只用于邮件）。 */
async function issueToken(deps: AppDeps, userId: string, kind: TokenKind): Promise<string> {
  const now = deps.clock.now();
  deps.db
    .update(emailTokens)
    .set({ usedAt: now })
    .where(and(eq(emailTokens.userId, userId), eq(emailTokens.kind, kind), isNull(emailTokens.usedAt)))
    .run();
  const token = generateToken();
  deps.db
    .insert(emailTokens)
    .values({
      id: newId(),
      userId,
      kind,
      tokenHash: await hashToken(token),
      expiresAt: new Date(now.getTime() + TOKEN_TTL_MS[kind]),
      usedAt: null,
      createdAt: now,
    })
    .run();
  return token;
}

/** 校验并一次性消费令牌，返回对应用户。任何失败都用同一句文案，避免泄露令牌状态。 */
async function consumeToken(deps: AppDeps, token: string, kind: TokenKind): Promise<UserRow> {
  const invalid = () => validation('链接无效或已过期，请重新申请');
  if (!isTokenShape(token)) throw invalid();
  const row = deps.db.select().from(emailTokens).where(eq(emailTokens.tokenHash, await hashToken(token))).get();
  const now = deps.clock.now();
  if (!row || row.kind !== kind || row.usedAt !== null || row.expiresAt.getTime() <= now.getTime()) throw invalid();
  deps.db.update(emailTokens).set({ usedAt: now }).where(eq(emailTokens.id, row.id)).run();
  const user = deps.db.select().from(users).where(eq(users.id, row.userId)).get();
  if (!user || user.deletedAt !== null) throw invalid();
  return user;
}

/** 作废该用户全部未使用的令牌（改密、重置、注销后调用）。 */
function revokeTokens(deps: AppDeps, userId: string): void {
  deps.db
    .update(emailTokens)
    .set({ usedAt: deps.clock.now() })
    .where(and(eq(emailTokens.userId, userId), isNull(emailTokens.usedAt)))
    .run();
}

/** 邮件里的落地链接；PUBLIC_BASE_URL 未配置时只给令牌，用户可在桌面端粘贴。 */
function actionLink(deps: AppDeps, path: string, token: string): string | null {
  const base = deps.env.publicBaseUrl.replace(/\/+$/, '');
  return base ? `${base}${path}?token=${encodeURIComponent(token)}` : null;
}

function mailBody(intro: string, link: string | null, token: string, expiresIn: string, tail: string): string {
  const lines = [intro, ''];
  if (link) lines.push(`点击链接继续：${link}`, '');
  lines.push(`验证码（可在桌面端粘贴）：${token}`, '', `链接与验证码 ${expiresIn}内有效。`, tail);
  return lines.join('\n');
}

// ---- 邮箱验证 ----

/** 发送验证邮件；已验证过则直接返回 false，不再发信。 */
export async function requestEmailVerification(deps: AppDeps, user: AuthUser): Promise<boolean> {
  if (user.emailVerifiedAt !== null) return false;
  const token = await issueToken(deps, user.id, 'verify');
  await deps.mailer.send({
    to: user.email,
    subject: '验证你的 The Water 邮箱',
    text: mailBody(
      `${user.displayName}，你好：\n\n请验证这个邮箱，之后才能找回密码、接收作品通知。`,
      actionLink(deps, '/auth/verify', token),
      token,
      '24 小时',
      '如果这不是你本人的操作，忽略这封信即可。',
    ),
  });
  return true;
}

/** 用令牌完成验证；顺带同步一次管理员名单（P0-3：验证后才可能提权）。 */
export async function verifyEmail(deps: AppDeps, token: string): Promise<AuthUser> {
  const row = await consumeToken(deps, token, 'verify');
  const now = deps.clock.now();
  if (row.emailVerifiedAt === null) {
    deps.db.update(users).set({ emailVerifiedAt: now, updatedAt: now }).where(eq(users.id, row.id)).run();
    row.emailVerifiedAt = now;
  }
  return toAuthUser(syncAdminRole(deps, row));
}

// ---- 找回与修改密码 ----

/**
 * 按邮箱发重置邮件。调用方无论如何都返回 202：账号不存在、已注销都静默处理，
 * 避免把「这个邮箱注册过没有」泄露出去。
 */
export async function requestPasswordReset(deps: AppDeps, email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const row = deps.db.select().from(users).where(eq(users.email, normalized)).get();
  if (!row || row.deletedAt !== null) return;
  const token = await issueToken(deps, row.id, 'reset');
  await deps.mailer.send({
    to: row.email,
    subject: '重置你的 The Water 密码',
    text: mailBody(
      `${row.displayName}，你好：\n\n我们收到了重置密码的请求。`,
      actionLink(deps, '/auth/reset', token),
      token,
      '1 小时',
      '如果这不是你本人的操作，忽略这封信即可，密码不会有任何变化。',
    ),
  });
}

/** 用令牌重置密码；成功后吊销该用户全部会话。 */
export async function resetPassword(deps: AppDeps, token: string, password: string): Promise<void> {
  const row = await consumeToken(deps, token, 'reset');
  const now = deps.clock.now();
  deps.db
    .update(users)
    .set({ passwordHash: await hashPassword(deps.env, password), updatedAt: now })
    .where(eq(users.id, row.id))
    .run();
  revokeTokens(deps, row.id);
  deps.db.delete(sessions).where(eq(sessions.userId, row.id)).run();
}

/** 登录态改密：校验旧密码，成功后吊销其它会话、保留当前会话。 */
export async function changePassword(
  deps: AppDeps,
  user: AuthUser,
  session: SessionRow,
  req: ChangePasswordRequest,
): Promise<void> {
  const row = deps.db.select().from(users).where(eq(users.id, user.id)).get();
  if (!row) throw notFound('用户');
  if (!(await verifyPassword(req.currentPassword, row.passwordHash))) {
    throw new ApiError('INVALID_CREDENTIALS', '当前密码不正确');
  }
  const now = deps.clock.now();
  deps.db
    .update(users)
    .set({ passwordHash: await hashPassword(deps.env, req.newPassword), updatedAt: now })
    .where(eq(users.id, row.id))
    .run();
  revokeTokens(deps, row.id);
  for (const s of deps.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, row.id)).all()) {
    if (s.id !== session.id) deps.db.delete(sessions).where(eq(sessions.id, s.id)).run();
  }
}

// ---- 会话（设备）列表 ----

export function listSessions(deps: AppDeps, user: AuthUser, current: SessionRow): SessionSummary[] {
  return deps.db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, user.id))
    .orderBy(desc(sessions.lastUsedAt))
    .all()
    .map((s) => ({
      id: s.id,
      clientLabel: s.clientLabel,
      createdAt: iso(s.createdAt),
      lastUsedAt: iso(s.lastUsedAt),
      expiresAt: iso(s.expiresAt),
      current: s.id === current.id,
    }));
}

/** 注销单台设备；只能注销自己的会话。 */
export function revokeSession(deps: AppDeps, user: AuthUser, sessionId: string): void {
  const res = deps.db.delete(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.userId, user.id))).run();
  if (changes(res) === 0) throw notFound('会话');
}

// ---- 数据导出 ----

/** 个人资料 + 自己全部作品的 bundle。过大或还没提交过版本的作品记进 skipped。 */
export function exportAccount(deps: AppDeps, user: AuthUser): AccountExportResponse {
  const rows = deps.db
    .select({ id: novels.id, title: novels.title, currentVersionId: novels.currentVersionId })
    .from(novels)
    .where(and(eq(novels.authorId, user.id), isNull(novels.deletedAt)))
    .orderBy(desc(novels.createdAt))
    .all();
  const bundles: NovelBundleV1[] = [];
  const skipped: AccountExportResponse['skipped'] = [];
  for (const n of rows) {
    if (!n.currentVersionId) {
      skipped.push({ novelId: n.id, title: n.title, reason: '还没有提交过版本' });
      continue;
    }
    try {
      bundles.push(buildBundle(deps, n.id, 'current', user, undefined));
    } catch (e) {
      skipped.push({ novelId: n.id, title: n.title, reason: e instanceof ApiError ? e.message : '导出失败' });
    }
  }
  return {
    exportedAt: iso(deps.clock.now()),
    profile: toUserDto(user, { includeEmail: true }),
    novels: bundles,
    skipped,
  };
}

// ---- 注销账号 ----

/** `deleted_` + 12 位 id 片段，正好落在 handle 的 3–20 位小写字母数字下划线里。 */
function anonymousHandle(userId: string, salt = ''): string {
  const raw = (userId + salt).replace(/[^a-z0-9]/gi, '').toLowerCase();
  return `deleted_${raw.slice(0, 12).padEnd(12, '0')}`;
}

/**
 * 注销账号。用户被外键引用（novels.authorId、comments.authorId），所以只做匿名化 + 置位
 * deletedAt，绝不 DELETE FROM users。delete_works 会先把全部作品软删并下架。
 */
export async function deleteAccount(deps: AppDeps, user: AuthUser, req: DeleteAccountRequest): Promise<void> {
  const row = deps.db.select().from(users).where(eq(users.id, user.id)).get();
  if (!row || row.deletedAt !== null) throw notFound('用户');
  if (!(await verifyPassword(req.password, row.passwordHash))) {
    throw new ApiError('INVALID_CREDENTIALS', '密码不正确');
  }
  const now = deps.clock.now();
  if (req.mode === 'delete_works') {
    deps.db
      .update(novels)
      .set({ deletedAt: now, visibility: 'unpublished', updatedAt: now })
      .where(and(eq(novels.authorId, user.id), isNull(novels.deletedAt)))
      .run();
  }
  const patch = {
    email: `deleted+${user.id}@invalid`,
    displayName: '已注销用户',
    bio: null,
    passwordHash: UNUSABLE_PASSWORD,
    role: 'user' as const,
    emailVerifiedAt: null,
    deletedAt: now,
    updatedAt: now,
  };
  let saved = false;
  for (let i = 0; i < 5 && !saved; i++) {
    try {
      deps.db
        .update(users)
        .set({ ...patch, handle: anonymousHandle(user.id, i ? String(i) : '') })
        .where(eq(users.id, user.id))
        .run();
      saved = true;
    } catch (e) {
      if (i === 4 || !String(e).includes('users_handle_uq')) throw e;
    }
  }
  revokeTokens(deps, user.id);
  deps.db.delete(sessions).where(eq(sessions.userId, user.id)).run();
}
