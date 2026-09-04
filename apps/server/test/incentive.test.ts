import { describe, expect, it } from 'bun:test';
import { DERIVATIVE_VIEW_SPLIT, LeaderboardResponseSchema, MyPointsResponseSchema, PUBLISH_POINTS, POINT_RULES } from '@the-water/shared';
import { createNovel, makeChapters, makeTestApp, publish, type TestApp } from './helpers';

const DAY = 24 * 60 * 60 * 1000;

const pointsOf = async (t: TestApp, token: string): Promise<number> =>
  (await t.json('GET', '/api/v1/me/points', { token })).body.points;

async function publishNovel(t: TestApp, token: string, title: string, seed = 1) {
  const n = await createNovel(t, token, { title, license: 'cc-by-sa', allowDerivatives: true });
  await publish(t, token, n.id, await makeChapters(1, seed));
  return n.id;
}

describe('publishing points', () => {
  it('pays more for an original first version than a derivative, and caps updates at one a day', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const original = await publishNovel(t, a, '原作');
    expect(await pointsOf(t, a)).toBe(PUBLISH_POINTS.original);

    // 同一天的第二、第三版只计一次。
    await publish(t, a, original, await makeChapters(2, 2));
    expect(await pointsOf(t, a)).toBe(PUBLISH_POINTS.original + POINT_RULES.version_published.points);
    await publish(t, a, original, await makeChapters(3, 3));
    expect(await pointsOf(t, a)).toBe(PUBLISH_POINTS.original + POINT_RULES.version_published.points);
    // 隔天再更新又能计分。
    t.clock.advance(DAY);
    await publish(t, a, original, await makeChapters(4, 4));
    expect(await pointsOf(t, a)).toBe(PUBLISH_POINTS.original + 2 * POINT_RULES.version_published.points);

    const fork = await t.json('POST', `/api/v1/novels/${original}/forks`, { token: b, body: {} });
    const deriv = await createNovel(t, b, { title: '续写', license: 'cc-by-sa', allowDerivatives: true, source: { forkId: fork.body.fork.id } } as never);
    await publish(t, b, deriv.id, await makeChapters(1, 9));
    // fork 给原作者加分，二创首发给二创作者加分。
    expect(await pointsOf(t, b)).toBe(PUBLISH_POINTS.derivative);
  });

  it('pays once when a novel is marked completed', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const id = await publishNovel(t, a, '原作');
    const before = await pointsOf(t, a);
    await t.json('PATCH', `/api/v1/novels/${id}`, { token: a, body: { writingStatus: 'completed' } });
    expect(await pointsOf(t, a)).toBe(before + POINT_RULES.novel_completed.points);
    await t.json('PATCH', `/api/v1/novels/${id}`, { token: a, body: { writingStatus: 'ongoing' } });
    await t.json('PATCH', `/api/v1/novels/${id}`, { token: a, body: { writingStatus: 'completed' } });
    expect(await pointsOf(t, a)).toBe(before + POINT_RULES.novel_completed.points);
  });
});

describe('interaction points', () => {
  it('pays for likes and forks once per person, and never for your own', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const id = await publishNovel(t, a, '原作');
    const base = await pointsOf(t, a);

    await t.json('PUT', `/api/v1/novels/${id}/like`, { token: a });
    expect(await pointsOf(t, a)).toBe(base);

    await t.json('PUT', `/api/v1/novels/${id}/like`, { token: b });
    expect(await pointsOf(t, a)).toBe(base + POINT_RULES.like_received.points);
    // 取消再点赞不重复计分，也不扣分。
    await t.json('DELETE', `/api/v1/novels/${id}/like`, { token: b });
    expect(await pointsOf(t, a)).toBe(base + POINT_RULES.like_received.points);
    await t.json('PUT', `/api/v1/novels/${id}/like`, { token: b });
    expect(await pointsOf(t, a)).toBe(base + POINT_RULES.like_received.points);

    await t.json('POST', `/api/v1/novels/${id}/forks`, { token: b, body: {} });
    await t.json('POST', `/api/v1/novels/${id}/forks`, { token: b, body: {} });
    expect(await pointsOf(t, a)).toBe(base + POINT_RULES.like_received.points + POINT_RULES.fork_received.points);
  });

  it('pays for followers once, and not for following yourself back and forth', async () => {
    const t = makeTestApp();
    const { token: a, user: au } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    await t.json('PUT', `/api/v1/users/${au.id}/follow`, { token: b });
    expect(await pointsOf(t, a)).toBe(POINT_RULES.follower_gained.points);
    await t.json('DELETE', `/api/v1/users/${au.id}/follow`, { token: b });
    await t.json('PUT', `/api/v1/users/${au.id}/follow`, { token: b });
    expect(await pointsOf(t, a)).toBe(POINT_RULES.follower_gained.points);
  });

  it('pays both sides of a comment, with daily caps and no self-award', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const id = await publishNovel(t, a, '原作');
    const authorBase = await pointsOf(t, a);

    await t.json('POST', `/api/v1/novels/${id}/comments`, { token: a, body: { body: '作者自评' } });
    expect(await pointsOf(t, a)).toBe(authorBase + POINT_RULES.comment_posted.points);

    await t.json('POST', `/api/v1/novels/${id}/comments`, { token: b, body: { body: '读者留言' } });
    expect(await pointsOf(t, b)).toBe(POINT_RULES.comment_posted.points);
    expect(await pointsOf(t, a)).toBe(authorBase + POINT_RULES.comment_posted.points + POINT_RULES.comment_received.points);

    // 每人每天最多 10 条留言计分。
    for (let i = 0; i < 12; i++) await t.json('POST', `/api/v1/novels/${id}/comments`, { token: b, body: { body: `第 ${i} 条` } });
    expect(await pointsOf(t, b)).toBe(POINT_RULES.comment_posted.dailyCap!.max * POINT_RULES.comment_posted.points);
  });

  it('splits view points between a derivative and its source, and caps views per novel per day', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const original = await publishNovel(t, a, '原作');
    const aAfterPublish = await pointsOf(t, a);

    // 作者自己读不计分。
    await t.json('POST', `/api/v1/novels/${original}/view`, { token: a });
    expect(await pointsOf(t, a)).toBe(aAfterPublish);
    // 登录读者与匿名访客都计分。
    await t.json('POST', `/api/v1/novels/${original}/view`, { token: b });
    expect(await pointsOf(t, a)).toBe(aAfterPublish + POINT_RULES.view_received.points);
    await t.json('POST', `/api/v1/novels/${original}/view`, { headers: { 'X-Client-Id': 'anonymous-visitor-1' } });
    expect(await pointsOf(t, a)).toBe(aAfterPublish + 2 * POINT_RULES.view_received.points);

    const fork = await t.json('POST', `/api/v1/novels/${original}/forks`, { token: b, body: {} });
    const deriv = await createNovel(t, b, { title: '续写', license: 'cc-by-sa', allowDerivatives: true, source: { forkId: fork.body.fork.id } } as never);
    await publish(t, b, deriv.id, await makeChapters(1, 9));
    const aBefore = await pointsOf(t, a);
    const bBefore = await pointsOf(t, b);
    const { token: reader } = await t.register('reader@example.com');
    await t.json('POST', `/api/v1/novels/${deriv.id}/view`, { token: reader });
    expect(await pointsOf(t, b)).toBe(bBefore + DERIVATIVE_VIEW_SPLIT.derivative);
    expect(await pointsOf(t, a)).toBe(aBefore + DERIVATIVE_VIEW_SPLIT.source);

    // 每本每天最多 30 次浏览计分，但 viewCount 照加。
    const cap = POINT_RULES.view_received.dailyCap!.max;
    for (let i = 0; i < cap + 5; i++) {
      await t.json('POST', `/api/v1/novels/${original}/view`, { headers: { 'X-Client-Id': `visitor-${i}-aaaaaaaa` } });
    }
    const ledger = (await t.json('GET', '/api/v1/me/points?limit=50', { token: a })).body.ledger.items;
    expect(ledger.filter((e: any) => e.kind === 'view_received').length).toBe(cap);
    expect((await t.json('GET', `/api/v1/novels/${original}`)).body.novel.viewCount).toBeGreaterThan(cap);
  });

  it('caps the derivative revenue share per source novel per day', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const original = await publishNovel(t, a, '原作');
    const fork = await t.json('POST', `/api/v1/novels/${original}/forks`, { token: b, body: {} });
    const deriv = await createNovel(t, b, { title: '续写', license: 'cc-by-sa', allowDerivatives: true, source: { forkId: fork.body.fork.id } } as never);
    await publish(t, b, deriv.id, await makeChapters(1, 9));

    const cap = POINT_RULES.view_shared.dailyCap!.max;
    for (let i = 0; i < cap + 5; i++) {
      await t.json('POST', `/api/v1/novels/${deriv.id}/view`, { headers: { 'X-Client-Id': `reader-${i}-bbbbbbbb` } });
    }
    const shared = (await t.json('GET', '/api/v1/me/points?limit=50', { token: a })).body.ledger.items.filter((e: any) => e.kind === 'view_shared');
    expect(shared.length).toBe(cap);
    // 分成记在原作名下，并注明来自哪一部二创。
    expect(shared[0].refId).toBe(original);
  });
});

describe('/me/points, badges and leaderboards', () => {
  it('reports points, level and the ledger', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    await publishNovel(t, a, '原作');
    const res = await t.json('GET', '/api/v1/me/points', { token: a });
    const body = MyPointsResponseSchema.parse(res.body);
    expect(body.points).toBe(PUBLISH_POINTS.original);
    expect(body.level.level).toBe(1);
    expect(body.level.next).toBe(100);
    expect(body.ledger.items[0]).toMatchObject({ kind: 'novel_published', points: PUBLISH_POINTS.original, refType: 'novel' });
    expect(body.ledger.items[0]!.label).toBeTruthy();
    expect((await t.json('GET', '/api/v1/me/points')).status).toBe(401);
  });

  it('awards badges as milestones are reached', async () => {
    const t = makeTestApp();
    const { token: a, user: au } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const original = await publishNovel(t, a, '原作');
    expect((await t.json('GET', '/api/v1/me/points', { token: a })).body.badges.map((x: any) => x.id)).toContain('first_publish');

    await t.json('POST', `/api/v1/novels/${original}/forks`, { token: b, body: {} });
    const badges = (await t.json('GET', '/api/v1/me/points', { token: a })).body.badges.map((x: any) => x.id);
    expect(badges).toContain('forked_1');
    expect(badges).not.toContain('forked_10');
    // 徽章不会重复发。
    await t.json('PUT', `/api/v1/users/${au.id}/follow`, { token: b });
    const again = (await t.json('GET', '/api/v1/me/points', { token: a })).body.badges;
    expect(again.length).toBe(new Set(again.map((x: any) => x.id)).size);
    // 作者主页也能看到徽章。
    expect((await t.json('GET', `/api/v1/users/${au.id}`)).body.user.badges.length).toBe(again.length);
  });

  it('ranks authors and novels, hides removed novels, and caches within the TTL', async () => {
    const t = makeTestApp();
    const { token: a, user: au } = await t.register('a@example.com');
    const { token: b, user: bu } = await t.register('b@example.com');
    const { token: admin } = await t.register('admin@example.com');
    const big = await publishNovel(t, a, '大书');
    await publishNovel(t, b, '小书', 5);
    await t.json('PUT', `/api/v1/novels/${big}/like`, { token: b });

    const authors = await t.json('GET', '/api/v1/leaderboard?board=authors&period=week');
    const board = LeaderboardResponseSchema.parse(authors.body);
    expect(board.novels).toBeNull();
    expect(board.authors!.map((x) => x.id)).toEqual([au.id, bu.id]);
    expect(board.authors![0]).toMatchObject({ rank: 1 });
    expect(board.authors![0]!.points).toBeGreaterThan(board.authors![1]!.points);

    const novels = await t.json('GET', '/api/v1/leaderboard?board=novels&period=month');
    expect(novels.body.authors).toBeNull();
    expect(novels.body.novels.map((n: any) => n.title)).toEqual(['大书', '小书']);

    // 缓存：下架后 TTL 内不变，推进时钟后刷新。
    await t.json('PATCH', `/api/v1/admin/novels/${big}/moderation`, { token: admin, body: { moderationStatus: 'removed' } });
    expect((await t.json('GET', '/api/v1/leaderboard?board=novels&period=month')).body.novels.length).toBe(2);
    t.clock.advance(121_000);
    expect((await t.json('GET', '/api/v1/leaderboard?board=novels&period=month')).body.novels.map((n: any) => n.title)).toEqual(['小书']);

    expect((await t.json('GET', '/api/v1/leaderboard?board=nope')).status).toBe(400);
    expect((await t.json('GET', '/api/v1/leaderboard?board=authors&period=all')).body.authors.length).toBe(2);
  });

  it('reverses a novel points when an admin takes it down with reversePoints', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const { token: admin } = await t.register('admin@example.com');
    const id = await publishNovel(t, a, '要下架的');
    await t.json('PUT', `/api/v1/novels/${id}/like`, { token: b });
    const before = await pointsOf(t, a);
    expect(before).toBeGreaterThan(0);

    await t.json('PATCH', `/api/v1/admin/novels/${id}/moderation`, { token: admin, body: { moderationStatus: 'removed', reversePoints: true } });
    expect(await pointsOf(t, a)).toBe(0);
    const ledger = (await t.json('GET', '/api/v1/me/points', { token: a })).body.ledger.items;
    expect(ledger[0]).toMatchObject({ kind: 'adjustment', points: -before });
    // 重复下架不会重复冲正。
    await t.json('PATCH', `/api/v1/admin/novels/${id}/moderation`, { token: admin, body: { moderationStatus: 'ok' } });
    await t.json('PATCH', `/api/v1/admin/novels/${id}/moderation`, { token: admin, body: { moderationStatus: 'removed', reversePoints: true } });
    expect(await pointsOf(t, a)).toBe(0);
  });
});
