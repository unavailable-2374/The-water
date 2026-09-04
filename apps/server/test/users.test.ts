import { describe, expect, it } from 'bun:test';
import { UserListResponseSchema, UserProfileResponseSchema, NovelListResponseSchema } from '@the-water/shared';
import { createNovel, makeChapters, makeTestApp, publish } from './helpers';

describe('handles', () => {
  it('generates a fallback handle at registration and exposes it on /auth/me', async () => {
    const t = makeTestApp();
    const { token, user } = await t.register('a@example.com');
    const me = await t.json('GET', '/api/v1/auth/me', { token });
    expect(me.body.user.handle).toMatch(/^u_[0-9a-f]{12}$/);
    expect(me.body.user.id).toBe(user.id);
  });

  it('accepts a requested handle, lowercases it, and rejects taken / reserved / malformed ones', async () => {
    const t = makeTestApp();
    const reg = await t.json('POST', '/api/v1/auth/register', {
      body: { email: 'ink@example.com', password: 'password123', displayName: '墨', handle: 'Ink_42' },
    });
    expect(reg.status).toBe(201);
    expect(reg.body.user.handle).toBe('ink_42');

    const dup = await t.json('POST', '/api/v1/auth/register', {
      body: { email: 'other@example.com', password: 'password123', displayName: '别人', handle: 'ink_42' },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('HANDLE_TAKEN');

    for (const handle of ['admin', 'ab', 'a'.repeat(21), '有中文', 'a-b']) {
      const bad = await t.json('POST', '/api/v1/auth/register', {
        body: { email: `${Math.random()}@example.com`, password: 'password123', displayName: 'x', handle },
      });
      expect(bad.status, handle).toBe(400);
    }
  });

  it('renames via PATCH /auth/me and moves the by-handle lookup', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const before = (await t.json('GET', '/api/v1/auth/me', { token })).body.user.handle;
    const patched = await t.json('PATCH', '/api/v1/auth/me', { token, body: { handle: 'linwan', bio: '守灯人' } });
    expect(patched.status).toBe(200);
    expect(patched.body.user.handle).toBe('linwan');
    expect((await t.json('GET', '/api/v1/users/by-handle/linwan')).status).toBe(200);
    expect((await t.json('GET', `/api/v1/users/by-handle/${before}`)).status).toBe(404);
    // 改成自己已有的用户名不算冲突。
    expect((await t.json('PATCH', '/api/v1/auth/me', { token, body: { handle: 'linwan' } })).status).toBe(200);

    const { token: other } = await t.register('b@example.com');
    const clash = await t.json('PATCH', '/api/v1/auth/me', { token: other, body: { handle: 'linwan' } });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('HANDLE_TAKEN');
  });
});

describe('author profile', () => {
  it('reports public stats and hides viewer relations from anonymous visitors', async () => {
    const t = makeTestApp({ env: { publicBaseUrl: 'https://water.example' } });
    const { token: a, user: au } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const original = await createNovel(t, a, { title: '原作', license: 'cc-by-sa', allowDerivatives: true });
    await publish(t, a, original.id, await makeChapters(2));
    const unpublished = await createNovel(t, a, { title: '还没发布' });
    expect(unpublished.visibility).toBe('unpublished');
    await t.json('PUT', `/api/v1/novels/${original.id}/like`, { token: b });

    const anon = await t.json('GET', `/api/v1/users/${au.id}`);
    const profile = UserProfileResponseSchema.parse(anon.body).user;
    expect(profile.viewer).toBeNull();
    expect(profile.stats.novelCount).toBe(1);
    expect(profile.stats.derivativeCount).toBe(0);
    expect(profile.stats.likeReceived).toBe(1);
    expect(profile.shareUrl).toBe(`https://water.example/u/${profile.handle}`);
    expect(profile.level.level).toBe(1);

    const seen = await t.json('GET', `/api/v1/users/${au.id}`, { token: b });
    expect(seen.body.user.viewer).toEqual({ following: false, followedBy: false, blocked: false, blockedBy: false });
    expect((await t.json('GET', '/api/v1/users/nobody')).status).toBe(404);
  });

  it('has no share url when PUBLIC_BASE_URL is unset', async () => {
    const t = makeTestApp();
    const { user } = await t.register('a@example.com');
    expect((await t.json('GET', `/api/v1/users/${user.id}`)).body.user.shareUrl).toBeNull();
  });

  it('lists an author public novels split by original / derivative', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: b, user: bu } = await t.register('b@example.com');
    const original = await createNovel(t, a, { title: '原作', license: 'cc-by-sa', allowDerivatives: true });
    const v1 = await publish(t, a, original.id, await makeChapters(2));
    const fork = await t.json('POST', `/api/v1/novels/${original.id}/forks`, { token: b, body: {} });
    const own = await createNovel(t, b, { title: 'B 的原创' });
    await publish(t, b, own.id, await makeChapters(1, 7));
    t.clock.advance(1000);
    const deriv = await createNovel(t, b, { title: 'B 的二创', license: 'cc-by-sa', allowDerivatives: true, source: { forkId: fork.body.fork.id } } as never);
    await publish(t, b, deriv.id, await makeChapters(2, 9));
    expect(v1.version.versionNumber).toBe(1);

    const all = await t.json('GET', `/api/v1/users/${bu.id}/novels`);
    expect(NovelListResponseSchema.parse(all.body).items.map((n) => n.title)).toEqual(['B 的二创', 'B 的原创']);
    expect((await t.json('GET', `/api/v1/users/${bu.id}/novels?kind=original`)).body.items.map((n: any) => n.title)).toEqual(['B 的原创']);
    const derivOnly = await t.json('GET', `/api/v1/users/${bu.id}/novels?kind=derivative`);
    expect(derivOnly.body.items.map((n: any) => n.title)).toEqual(['B 的二创']);
    expect(derivOnly.body.items[0].isDerivative).toBe(true);
    expect(derivOnly.body.items[0].author.handle).toBeTruthy();

    const profile = (await t.json('GET', `/api/v1/users/${bu.id}`)).body.user;
    expect(profile.stats).toMatchObject({ novelCount: 1, derivativeCount: 1 });
    // 原作者的作品被二创了一次。
    const aProfile = (await t.json('GET', `/api/v1/users/by-handle/${(await t.json('GET', '/api/v1/auth/me', { token: a })).body.user.handle}`)).body.user;
    expect(aProfile.stats.derivedCount).toBe(1);
  });
});

describe('follow', () => {
  it('is idempotent, keeps both counters, and refuses self-follow', async () => {
    const t = makeTestApp();
    const { token: a, user: au } = await t.register('a@example.com');
    const { token: b, user: bu } = await t.register('b@example.com');

    expect((await t.json('PUT', `/api/v1/users/${au.id}/follow`)).status).toBe(401);
    expect((await t.json('PUT', `/api/v1/users/${bu.id}/follow`, { token: b })).status).toBe(400);
    expect((await t.json('PUT', '/api/v1/users/nobody/follow', { token: b })).status).toBe(404);

    const f1 = await t.json('PUT', `/api/v1/users/${au.id}/follow`, { token: b });
    expect(f1.body).toEqual({ following: true, followerCount: 1 });
    expect((await t.json('PUT', `/api/v1/users/${au.id}/follow`, { token: b })).body).toEqual({ following: true, followerCount: 1 });

    const aProfile = (await t.json('GET', `/api/v1/users/${au.id}`, { token: b })).body.user;
    expect(aProfile.followerCount).toBe(1);
    expect(aProfile.viewer).toMatchObject({ following: true, followedBy: false });
    expect((await t.json('GET', `/api/v1/users/${bu.id}`, { token: b })).body.user.stats.followingCount).toBe(1);

    const following = await t.json('GET', '/api/v1/me/following', { token: b });
    expect(UserListResponseSchema.parse(following.body).items.map((u) => u.id)).toEqual([au.id]);
    expect((await t.json('GET', '/api/v1/me/followers', { token: a })).body.items.map((u: any) => u.id)).toEqual([bu.id]);

    const u1 = await t.json('DELETE', `/api/v1/users/${au.id}/follow`, { token: b });
    expect(u1.body).toEqual({ following: false, followerCount: 0 });
    expect((await t.json('DELETE', `/api/v1/users/${au.id}/follow`, { token: b })).body).toEqual({ following: false, followerCount: 0 });
    expect((await t.json('GET', '/api/v1/me/following', { token: b })).body.items).toEqual([]);
  });

  it('paginates relation lists with a stable cursor', async () => {
    const t = makeTestApp();
    const { token: me } = await t.register('me@example.com');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { user } = await t.register(`u${i}@example.com`);
      ids.push(user.id);
      t.clock.advance(1000);
      await t.json('PUT', `/api/v1/users/${user.id}/follow`, { token: me });
    }
    const first = await t.json('GET', '/api/v1/me/following?limit=2', { token: me });
    expect(first.body.items.map((u: any) => u.id)).toEqual([ids[2], ids[1]]);
    const second = await t.json(`GET`, `/api/v1/me/following?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`, { token: me });
    expect(second.body.items.map((u: any) => u.id)).toEqual([ids[0]]);
    expect(second.body.nextCursor).toBeNull();
  });
});

describe('block', () => {
  it('drops follows in both directions and forbids interaction afterwards', async () => {
    const t = makeTestApp();
    const { token: a, user: au } = await t.register('a@example.com');
    const { token: b, user: bu } = await t.register('b@example.com');
    await t.json('PUT', `/api/v1/users/${bu.id}/follow`, { token: a });
    await t.json('PUT', `/api/v1/users/${au.id}/follow`, { token: b });

    expect((await t.json('PUT', `/api/v1/users/${au.id}/block`, { token: a })).status).toBe(400);
    const blocked = await t.json('PUT', `/api/v1/users/${au.id}/block`, { token: b });
    expect(blocked.body).toEqual({ blocked: true });
    expect((await t.json('PUT', `/api/v1/users/${au.id}/block`, { token: b })).body).toEqual({ blocked: true });

    expect((await t.json('GET', '/api/v1/me/following', { token: a })).body.items).toEqual([]);
    expect((await t.json('GET', '/api/v1/me/following', { token: b })).body.items).toEqual([]);
    const aSeen = (await t.json('GET', `/api/v1/users/${au.id}`, { token: b })).body.user;
    expect(aSeen.followerCount).toBe(0);
    expect(aSeen.viewer).toMatchObject({ blocked: true, blockedBy: false, following: false });
    expect((await t.json('GET', `/api/v1/users/${bu.id}`, { token: a })).body.user.viewer).toMatchObject({ blocked: false, blockedBy: true });

    // 两个方向都不能再关注。
    expect((await t.json('PUT', `/api/v1/users/${au.id}/follow`, { token: b })).body.error.code).toBe('BLOCKED');
    expect((await t.json('PUT', `/api/v1/users/${bu.id}/follow`, { token: a })).body.error.code).toBe('BLOCKED');

    const blocks = await t.json('GET', '/api/v1/me/blocks', { token: b });
    expect(blocks.body.items.map((u: any) => u.id)).toEqual([au.id]);

    expect((await t.json('DELETE', `/api/v1/users/${au.id}/block`, { token: b })).body).toEqual({ blocked: false });
    expect((await t.json('GET', '/api/v1/me/blocks', { token: b })).body.items).toEqual([]);
    // 解除屏蔽不恢复关注，但可以重新关注。
    expect((await t.json('GET', '/api/v1/me/following', { token: b })).body.items).toEqual([]);
    expect((await t.json('PUT', `/api/v1/users/${au.id}/follow`, { token: b })).status).toBe(200);
  });

  it('hides the blocked author works from browse, search and their author page', async () => {
    const t = makeTestApp();
    const { token: a, user: au } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const { token: c } = await t.register('c@example.com');
    const n = await createNovel(t, a, { title: '灯下长街', license: 'cc-by-sa', allowDerivatives: true });
    await publish(t, a, n.id, await makeChapters(1));

    await t.json('PUT', `/api/v1/users/${au.id}/block`, { token: b });

    expect((await t.json('GET', '/api/v1/novels', { token: b })).body.items).toEqual([]);
    expect((await t.json('GET', '/api/v1/novels?q=长街', { token: b })).body.items).toEqual([]);
    expect((await t.json('GET', `/api/v1/users/${au.id}/novels`, { token: b })).body.items).toEqual([]);
    // 屏蔽只影响列表，直链与匿名浏览不受影响。
    expect((await t.json('GET', `/api/v1/novels/${n.id}`, { token: b })).status).toBe(200);
    expect((await t.json('GET', '/api/v1/novels')).body.items.length).toBe(1);
    expect((await t.json('GET', '/api/v1/novels', { token: c })).body.items.length).toBe(1);
    // 被屏蔽的一方同样看不到对方的作品。
    const nb = await createNovel(t, b, { title: 'B 的书' });
    await publish(t, b, nb.id, await makeChapters(1, 3));
    expect((await t.json('GET', '/api/v1/novels', { token: a })).body.items.map((x: any) => x.title)).toEqual(['灯下长街']);

    expect((await t.json('PUT', `/api/v1/novels/${n.id}/like`, { token: b })).body.error.code).toBe('BLOCKED');
    expect((await t.json('POST', `/api/v1/novels/${n.id}/forks`, { token: b, body: {} })).body.error.code).toBe('BLOCKED');
  });
});
