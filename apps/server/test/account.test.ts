/**
 * P0-3 管理员授予 + P0-4 账号生命周期（邮箱验证 / 找回密码 / 改密 / 注销 / 会话 / 导出）。
 */
import { describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  AccountExportResponseSchema,
  MeResponseSchema,
  OkResponseSchema,
  SessionListResponseSchema,
} from '@the-water/shared';
import { novels, users } from '../src/db/schema';
import { DAY, HOUR } from '../src/lib/time';
import { createNovel, expectSchema, makeChapters, makeTestApp, publish, type TestApp } from './helpers';

const PASSWORD = 'password123';

/** 直接走 HTTP 注册（不像 helpers.register 那样自动把邮箱标记为已验证）。 */
async function rawRegister(t: TestApp, email: string, displayName = 'X') {
  const r = await t.json('POST', '/api/v1/auth/register', { body: { email, password: PASSWORD, displayName } });
  expect(r.status).toBe(201);
  return { token: r.body.token as string, user: r.body.user as { id: string; role: string } };
}

function lastToken(t: TestApp): string {
  const mail = t.outbox.at(-1);
  expect(mail).toBeTruthy();
  const m = /tw_[A-Za-z0-9_-]{43}/.exec(mail!.text);
  expect(m).toBeTruthy();
  return m![0];
}

const loginAs = (t: TestApp, email: string, password = PASSWORD) =>
  t.json('POST', '/api/v1/auth/login', { body: { email, password } });

describe('P0-3 管理员授予', () => {
  it('ADMIN_EMAILS 中的邮箱新注册仍是 user，验证邮箱后登录才变 admin', async () => {
    const t = makeTestApp();
    const reg = await rawRegister(t, 'admin@example.com', '管理员');
    expect(reg.user.role).toBe('user');
    // 未验证时登录也不提权。
    expect((await loginAs(t, 'admin@example.com')).body.user.role).toBe('user');
    // 管理端点仍然拒绝。
    expect((await t.json('GET', '/api/v1/admin/reports', { token: reg.token })).status).toBe(403);

    const req = await t.json('POST', '/api/v1/auth/email/verify/request', { token: reg.token });
    expect(req.status).toBe(202);
    const verified = await t.json('POST', '/api/v1/auth/email/verify', { body: { token: lastToken(t) } });
    expect(verified.status).toBe(200);
    expectSchema(MeResponseSchema, verified.body);
    expect(verified.body.user.role).toBe('admin');

    const after = await loginAs(t, 'admin@example.com');
    expect(after.body.user.role).toBe('admin');
    expect((await t.json('GET', '/api/v1/admin/reports', { token: after.body.token })).status).toBe(200);
  });

  it('邮箱从 ADMIN_EMAILS 移除后，下次登录降回 user', async () => {
    const t = makeTestApp();
    const { user } = await t.register('admin@example.com', '管理员');
    expect(user.role).toBe('admin');
    t.deps.env.adminEmails = ['someone-else@example.com'];
    const relog = await loginAs(t, 'admin@example.com');
    expect(relog.body.user.role).toBe('user');
    expect(t.deps.db.select().from(users).where(eq(users.id, user.id)).get()!.role).toBe('user');
  });

  it('ADMIN_EMAILS 为空时不动 role，完全交给 admin:grant', async () => {
    const t = makeTestApp({ env: { adminEmails: [] } });
    const { user } = await t.register('boss@example.com');
    t.deps.db.update(users).set({ role: 'admin' }).where(eq(users.id, user.id)).run();
    const relog = await loginAs(t, 'boss@example.com');
    expect(relog.body.user.role).toBe('admin');
  });
});

describe('P0-4 邮箱验证', () => {
  it('令牌一次性、24 小时过期、重发作废旧令牌', async () => {
    const t = makeTestApp();
    const { token } = await rawRegister(t, 'v@example.com');
    await t.json('POST', '/api/v1/auth/email/verify/request', { token });
    const first = lastToken(t);
    await t.json('POST', '/api/v1/auth/email/verify/request', { token });
    const second = lastToken(t);
    expect(second).not.toBe(first);
    // 旧令牌已作废。
    expect((await t.json('POST', '/api/v1/auth/email/verify', { body: { token: first } })).status).toBe(400);

    const ok = await t.json('POST', '/api/v1/auth/email/verify', { body: { token: second } });
    expect(ok.status).toBe(200);
    // 用过不能复用。
    expect((await t.json('POST', '/api/v1/auth/email/verify', { body: { token: second } })).status).toBe(400);
    // 已验证后不再发信。
    const before = t.outbox.length;
    await t.json('POST', '/api/v1/auth/email/verify/request', { token });
    expect(t.outbox.length).toBe(before);
  });

  it('超过 24 小时的验证令牌失效', async () => {
    const t = makeTestApp();
    const { token } = await rawRegister(t, 'v2@example.com');
    await t.json('POST', '/api/v1/auth/email/verify/request', { token });
    const mailToken = lastToken(t);
    t.clock.advance(24 * HOUR + 1000);
    const r = await t.json('POST', '/api/v1/auth/email/verify', { body: { token: mailToken } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('形状不对的令牌也走同一句文案', async () => {
    const t = makeTestApp();
    const r = await t.json('POST', '/api/v1/auth/email/verify', { body: { token: 'not-a-token' } });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('无效');
  });
});

describe('P0-4 找回密码', () => {
  it('未注册邮箱也返回 202 且不发信（不泄露账号是否存在）', async () => {
    const t = makeTestApp();
    const r = await t.json('POST', '/api/v1/auth/password/forgot', { body: { email: 'nobody@example.com' } });
    expect(r.status).toBe(202);
    expectSchema(OkResponseSchema, r.body);
    expect(t.outbox.length).toBe(0);
  });

  it('重置成功后旧会话全部失效，新密码可登录', async () => {
    const t = makeTestApp();
    const { token: old } = await t.register('r@example.com');
    const r = await t.json('POST', '/api/v1/auth/password/forgot', { body: { email: 'R@Example.com' } });
    expect(r.status).toBe(202);
    expect(t.outbox.length).toBe(1);
    expect(t.outbox[0]!.to).toBe('r@example.com');

    const reset = await t.json('POST', '/api/v1/auth/password/reset', { body: { token: lastToken(t), password: 'brand-new-pass' } });
    expect(reset.status).toBe(200);
    expect((await t.json('GET', '/api/v1/auth/me', { token: old })).status).toBe(401);
    expect((await loginAs(t, 'r@example.com', PASSWORD)).status).toBe(401);
    expect((await loginAs(t, 'r@example.com', 'brand-new-pass')).status).toBe(200);
  });

  it('重置令牌 1 小时过期且不可复用', async () => {
    const t = makeTestApp();
    await t.register('r2@example.com');
    await t.json('POST', '/api/v1/auth/password/forgot', { body: { email: 'r2@example.com' } });
    const expiring = lastToken(t);
    t.clock.advance(HOUR + 1000);
    expect((await t.json('POST', '/api/v1/auth/password/reset', { body: { token: expiring, password: 'x'.repeat(10) } })).status).toBe(400);

    await t.json('POST', '/api/v1/auth/password/forgot', { body: { email: 'r2@example.com' } });
    const fresh = lastToken(t);
    expect((await t.json('POST', '/api/v1/auth/password/reset', { body: { token: fresh, password: 'y'.repeat(10) } })).status).toBe(200);
    expect((await t.json('POST', '/api/v1/auth/password/reset', { body: { token: fresh, password: 'z'.repeat(10) } })).status).toBe(400);
  });
});

describe('P0-4 修改密码', () => {
  it('旧密码错误 → INVALID_CREDENTIALS；成功后只保留当前会话', async () => {
    const t = makeTestApp();
    const { token: current } = await t.register('c@example.com');
    const other = (await loginAs(t, 'c@example.com')).body.token as string;

    const bad = await t.json('PATCH', '/api/v1/auth/password', { token: current, body: { currentPassword: 'wrong-pass', newPassword: 'new-password' } });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');

    const ok = await t.json('PATCH', '/api/v1/auth/password', { token: current, body: { currentPassword: PASSWORD, newPassword: 'new-password' } });
    expect(ok.status).toBe(200);
    expect((await t.json('GET', '/api/v1/auth/me', { token: current })).status).toBe(200);
    expect((await t.json('GET', '/api/v1/auth/me', { token: other })).status).toBe(401);
    expect((await loginAs(t, 'c@example.com', 'new-password')).status).toBe(200);
  });
});

describe('§3.6 登录设备', () => {
  it('列出会话并标出当前会话，可单独注销一台', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('s@example.com');
    const b = (await t.json('POST', '/api/v1/auth/login', { body: { email: 's@example.com', password: PASSWORD, clientLabel: 'iPad' } })).body.token as string;

    const list = await t.json('GET', '/api/v1/auth/sessions', { token: a });
    expect(list.status).toBe(200);
    const parsed = expectSchema(SessionListResponseSchema, list.body);
    expect(parsed.sessions.length).toBe(2);
    expect(parsed.sessions.filter((s) => s.current).length).toBe(1);
    const target = parsed.sessions.find((s) => !s.current)!;
    expect(target.clientLabel).toBe('iPad');

    const del = await t.json('DELETE', `/api/v1/auth/sessions/${target.id}`, { token: a });
    expect(del.status).toBe(200);
    expect((await t.json('GET', '/api/v1/auth/me', { token: b })).status).toBe(401);
    expect((await t.json('GET', '/api/v1/auth/me', { token: a })).status).toBe(200);
    // 别人的会话注销不了。
    const { token: outsider } = await t.register('s2@example.com');
    const own = expectSchema(SessionListResponseSchema, (await t.json('GET', '/api/v1/auth/sessions', { token: a })).body).sessions[0]!;
    expect((await t.json('DELETE', `/api/v1/auth/sessions/${own.id}`, { token: outsider })).status).toBe(404);
  });
});

describe('P0-4 数据导出', () => {
  it('导出个人资料与自己全部作品的 bundle', async () => {
    const t = makeTestApp();
    const { token } = await t.register('e@example.com');
    const novel = await createNovel(t, token);
    await publish(t, token, novel.id, await makeChapters(2));
    await createNovel(t, token, { title: '还没提交的草稿' });

    const r = await t.json('GET', '/api/v1/auth/me/export', { token });
    expect(r.status).toBe(200);
    const dump = expectSchema(AccountExportResponseSchema, r.body);
    expect(dump.profile.email).toBe('e@example.com');
    expect(dump.novels.length).toBe(1);
    expect(dump.novels[0]!.chapters.length).toBe(2);
    expect(dump.skipped.length).toBe(1);
    expect(dump.skipped[0]!.title).toBe('还没提交的草稿');
  });
});

describe('P0-4 注销账号', () => {
  it('keep_works：作品保留，作者变成已注销用户，会话全部失效', async () => {
    const t = makeTestApp();
    const { token, user } = await t.register('d@example.com', '要走的人');
    const novel = await createNovel(t, token);
    await publish(t, token, novel.id, await makeChapters(1));

    const bad = await t.json('DELETE', '/api/v1/auth/me', { token, body: { password: 'wrong-pass', mode: 'keep_works' } });
    expect(bad.status).toBe(401);

    const gone = await t.json('DELETE', '/api/v1/auth/me', { token, body: { password: PASSWORD, mode: 'keep_works' } });
    expect(gone.status).toBe(200);

    const row = t.deps.db.select().from(users).where(eq(users.id, user.id)).get()!;
    expect(row.deletedAt).not.toBeNull();
    expect(row.email).toBe(`deleted+${user.id}@invalid`);
    expect(row.handle.startsWith('deleted_')).toBe(true);
    expect(row.displayName).toBe('已注销用户');
    expect(row.bio).toBeNull();

    expect((await t.json('GET', '/api/v1/auth/me', { token })).status).toBe(401);
    expect((await loginAs(t, 'd@example.com')).status).toBe(401);

    // 作品仍在，作者显示为已注销。
    const detail = await t.json('GET', `/api/v1/novels/${novel.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.novel.author.displayName).toBe('已注销用户');
  });

  it('delete_works：作品一并软删下架', async () => {
    const t = makeTestApp();
    const { token, user } = await t.register('d2@example.com');
    const novel = await createNovel(t, token);
    await publish(t, token, novel.id, await makeChapters(1));

    const gone = await t.json('DELETE', '/api/v1/auth/me', { token, body: { password: PASSWORD, mode: 'delete_works' } });
    expect(gone.status).toBe(200);

    const row = t.deps.db.select().from(novels).where(eq(novels.id, novel.id)).get()!;
    expect(row.deletedAt).not.toBeNull();
    expect(row.visibility).toBe('unpublished');
    expect((await t.json('GET', `/api/v1/novels/${novel.id}`)).status).toBe(404);
    // 用户行还在（有外键引用），只是被匿名化。
    expect(t.deps.db.select().from(users).where(eq(users.id, user.id)).get()).toBeTruthy();
  });

  it('注销后邮箱不可再登录，也不会因此泄露账号存在与否', async () => {
    const t = makeTestApp();
    const { token } = await t.register('d3@example.com');
    await t.json('DELETE', '/api/v1/auth/me', { token, body: { password: PASSWORD, mode: 'keep_works' } });
    const r = await loginAs(t, 'd3@example.com');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
    // 找回密码同样静默。
    const forgot = await t.json('POST', '/api/v1/auth/password/forgot', { body: { email: 'd3@example.com' } });
    expect(forgot.status).toBe(202);
    expect(t.outbox.length).toBe(0);
  });
});

describe('限流', () => {
  it('找回密码按 IP 限流', async () => {
    const t = makeTestApp({ rateLimits: { password: { max: 2, windowMs: HOUR } } });
    const hit = () => t.json('POST', '/api/v1/auth/password/forgot', { body: { email: 'nobody@example.com' } });
    expect((await hit()).status).toBe(202);
    expect((await hit()).status).toBe(202);
    const limited = await hit();
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    t.clock.advance(HOUR + 1000);
    expect((await hit()).status).toBe(202);
  });
});

describe('会话过期与账号注销的相互作用', () => {
  it('注销后即使会话未过期也 401', async () => {
    const t = makeTestApp();
    const { token } = await t.register('d4@example.com');
    await t.json('DELETE', '/api/v1/auth/me', { token, body: { password: PASSWORD, mode: 'keep_works' } });
    t.clock.advance(DAY);
    expect((await t.json('GET', '/api/v1/auth/me', { token })).status).toBe(401);
  });
});
