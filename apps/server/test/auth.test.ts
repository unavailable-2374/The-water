import { describe, expect, it } from 'bun:test';
import { AuthResponseSchema, MeResponseSchema } from '@the-water/shared';
import { DAY, HOUR } from '../src/lib/time';
import { sessions } from '../src/db/schema';
import { expectSchema, makeTestApp } from './helpers';

describe('auth', () => {
  it('registers, returns token, and /auth/me works', async () => {
    const t = makeTestApp();
    const r = await t.json('POST', '/api/v1/auth/register', {
      body: { email: 'Alice@Example.com', password: 'password123', displayName: '爱丽丝' },
    });
    expect(r.status).toBe(201);
    const auth = expectSchema(AuthResponseSchema, r.body);
    expect(auth.token.startsWith('tw_')).toBe(true);
    expect(auth.token.length).toBe(46);
    expect(auth.user.email).toBe('alice@example.com');
    expect(auth.user.role).toBe('user');
    expect(r.res.headers.get('X-Request-Id')).toBeTruthy();

    const me = await t.json('GET', '/api/v1/auth/me', { token: auth.token });
    expect(me.status).toBe(200);
    expectSchema(MeResponseSchema, me.body);
    expect(me.body.user.id).toBe(auth.user.id);
  });

  it('注册时不按 ADMIN_EMAILS 提权（P0-3）', async () => {
    const t = makeTestApp();
    const r = await t.json('POST', '/api/v1/auth/register', {
      body: { email: 'admin@example.com', password: 'password123', displayName: '管理员' },
    });
    expect(r.status).toBe(201);
    expect(r.body.user.role).toBe('user');
  });

  it('账号不存在时也走一次密码校验（恒定时间，§3.6）', async () => {
    const t = makeTestApp();
    await t.register('timing@example.com');
    const missing = await t.json('POST', '/api/v1/auth/login', { body: { email: 'ghost@example.com', password: 'password123' } });
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('INVALID_CREDENTIALS');
    // 与「账号存在但密码错」的响应完全一致，外部看不出差别。
    const wrong = await t.json('POST', '/api/v1/auth/login', { body: { email: 'timing@example.com', password: 'wrong-pass' } });
    expect(wrong.status).toBe(missing.status);
    expect(wrong.body.error).toEqual(missing.body.error);
  });

  it('rejects duplicate email (case-insensitive) with EMAIL_TAKEN', async () => {
    const t = makeTestApp();
    await t.register('bob@example.com');
    const r = await t.json('POST', '/api/v1/auth/register', {
      body: { email: 'BOB@example.com', password: 'password123', displayName: 'Bob2' },
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('login with wrong password → INVALID_CREDENTIALS; right password → token', async () => {
    const t = makeTestApp();
    await t.register('carol@example.com');
    const bad = await t.json('POST', '/api/v1/auth/login', { body: { email: 'carol@example.com', password: 'wrong-pass' } });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
    const ok = await t.json('POST', '/api/v1/auth/login', { body: { email: 'carol@example.com', password: 'password123' } });
    expect(ok.status).toBe(200);
    expectSchema(AuthResponseSchema, ok.body);
  });

  it('validation errors use the envelope', async () => {
    const t = makeTestApp();
    const r = await t.json('POST', '/api/v1/auth/register', { body: { email: 'nope', password: 'short', displayName: '' } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(r.body.error.details.issues)).toBe(true);
    const bad = await t.json('POST', '/api/v1/auth/register', { raw: '{not json' });
    expect(bad.status).toBe(400);
  });

  it('unauthenticated and malformed tokens', async () => {
    const t = makeTestApp();
    const anon = await t.json('GET', '/api/v1/auth/me');
    expect(anon.status).toBe(401);
    expect(anon.body.error.code).toBe('UNAUTHORIZED');
    const bad = await t.json('GET', '/api/v1/auth/me', { token: 'tw_' + 'x'.repeat(43) });
    expect(bad.status).toBe(401);
    const weird = await t.json('GET', '/api/v1/auth/me', { headers: { Authorization: 'Basic abc' } });
    expect(weird.status).toBe(401);
  });

  it('session expires after 30 days but slides when used', async () => {
    const t = makeTestApp();
    const { token } = await t.register('dave@example.com');
    // 使用中：每隔 10 天访问一次，应持续有效。
    for (let i = 0; i < 6; i++) {
      t.clock.advance(10 * DAY);
      const r = await t.json('GET', '/api/v1/auth/me', { token });
      expect(r.status).toBe(200);
    }
    // 闲置 31 天后过期。
    t.clock.advance(31 * DAY);
    const expired = await t.json('GET', '/api/v1/auth/me', { token });
    expect(expired.status).toBe(401);
    expect(expired.body.error.message).toContain('过期');
  });

  it('renewal is throttled to once per hour', async () => {
    const t = makeTestApp();
    const r = await t.json('POST', '/api/v1/auth/register', { body: { email: 'e@example.com', password: 'password123', displayName: 'E' } });
    const token = r.body.token;
    const before = new Date(r.body.expiresAt).getTime();
    t.clock.advance(10 * 60_000);
    await t.json('GET', '/api/v1/auth/me', { token });
    const row1 = t.deps.db.select().from(sessions).get()!;
    expect(row1.expiresAt.getTime()).toBe(before);
    t.clock.advance(HOUR);
    await t.json('GET', '/api/v1/auth/me', { token });
    const row2 = t.deps.db.select().from(sessions).get()!;
    expect(row2.expiresAt.getTime()).toBeGreaterThan(before);
  });

  it('logout revokes only that session; DELETE /auth/sessions revokes all', async () => {
    const t = makeTestApp();
    const { token: t1 } = await t.register('f@example.com');
    const login = await t.json('POST', '/api/v1/auth/login', { body: { email: 'f@example.com', password: 'password123', clientLabel: 'mac' } });
    const t2 = login.body.token;
    const out = await t.json('POST', '/api/v1/auth/logout', { token: t1 });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true });
    expect((await t.json('GET', '/api/v1/auth/me', { token: t1 })).status).toBe(401);
    expect((await t.json('GET', '/api/v1/auth/me', { token: t2 })).status).toBe(200);
    const login2 = await t.json('POST', '/api/v1/auth/login', { body: { email: 'f@example.com', password: 'password123' } });
    const all = await t.json('DELETE', '/api/v1/auth/sessions', { token: t2 });
    expect(all.status).toBe(200);
    expect((await t.json('GET', '/api/v1/auth/me', { token: t2 })).status).toBe(401);
    expect((await t.json('GET', '/api/v1/auth/me', { token: login2.body.token })).status).toBe(401);
  });

  it('PATCH /auth/me updates displayName and bio', async () => {
    const t = makeTestApp();
    const { token } = await t.register('g@example.com');
    const r = await t.json('PATCH', '/api/v1/auth/me', { token, body: { displayName: '  新名字 ', bio: '写小说的人' } });
    expect(r.status).toBe(200);
    expectSchema(MeResponseSchema, r.body);
    expect(r.body.user.displayName).toBe('新名字');
    expect(r.body.user.bio).toBe('写小说的人');
  });

  it('rate limits login attempts per IP', async () => {
    const t = makeTestApp({ rateLimits: { login: { max: 3, windowMs: 60_000 } } });
    await t.register('h@example.com');
    const attempt = () => t.json('POST', '/api/v1/auth/login', { body: { email: 'h@example.com', password: 'wrong-pass' } });
    for (let i = 0; i < 3; i++) expect((await attempt()).status).toBe(401);
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.res.headers.get('Retry-After')).toBeTruthy();
    t.clock.advance(61_000);
    expect((await attempt()).status).toBe(401);
  });
});
