import { describe, expect, it } from 'bun:test';
import { FeedResponseSchema, FoldedFeedResponseSchema } from '@the-water/shared';
import { createNovel, makeChapters, makeTestApp, publish } from './helpers';

/** 建一本已发布的小说，返回 id。 */
async function publishNovel(t: ReturnType<typeof makeTestApp>, token: string, title: string, seed = 1) {
  const n = await createNovel(t, token, { title, license: 'cc-by-sa', allowDerivatives: true });
  await publish(t, token, n.id, await makeChapters(1, seed));
  return n.id;
}

describe('feed', () => {
  it('records publish / update / complete as three kinds of activity', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const id = await publishNovel(t, a, '灯下长街');
    t.clock.advance(1000);
    await publish(t, a, id, await makeChapters(2, 2), { changeNote: '补了第二章' });
    t.clock.advance(1000);
    await t.json('PATCH', `/api/v1/novels/${id}`, { token: a, body: { writingStatus: 'completed' } });

    // 折叠是默认行为，逐条动态要显式关掉（§3.4）。
    const feed = await t.json('GET', '/api/v1/feed?scope=all&collapse=false');
    const page = FeedResponseSchema.parse(feed.body);
    expect(page.items.map((i) => i.kind)).toEqual(['novel_completed', 'version_published', 'novel_published']);
    const update = page.items[1]!;
    expect(update.version).toMatchObject({ versionNumber: 2, changeNote: '补了第二章' });
    expect(update.novel.isDerivative).toBe(false);
    expect(update.actor.handle).toBeTruthy();
    expect(page.items[0]!.version).toBeNull();

    // 再次切到完结不会重复记。
    await t.json('PATCH', `/api/v1/novels/${id}`, { token: a, body: { writingStatus: 'ongoing' } });
    await t.json('PATCH', `/api/v1/novels/${id}`, { token: a, body: { writingStatus: 'completed' } });
    expect((await t.json('GET', '/api/v1/feed?scope=all&collapse=false')).body.items.filter((i: any) => i.kind === 'novel_completed').length).toBe(1);
  });

  it('folds one novel into a single item and counts what was folded (§3.4)', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const id = await publishNovel(t, a, '连更的书');
    // 连发四个版本：不折叠是 5 条（首发 + 4 次更新），折叠后只剩 1 条。
    for (let i = 0; i < 4; i++) {
      t.clock.advance(1000);
      await publish(t, a, id, await makeChapters(i + 2, i + 10), { changeNote: `第 ${i + 2} 章` });
    }
    t.clock.advance(1000);
    const other = await publishNovel(t, a, '另一本', 99);
    expect(other).toBeTruthy();

    const raw = await t.json('GET', '/api/v1/feed?scope=all&collapse=false');
    expect(raw.body.items.length).toBe(6);

    const folded = await t.json('GET', '/api/v1/feed?scope=all');
    const page = FoldedFeedResponseSchema.parse(folded.body);
    expect(page.items.map((i) => i.novel.title)).toEqual(['另一本', '连更的书']);
    expect(page.items[1]!.collapsedCount).toBe(5);
    expect(page.items[0]!.collapsedCount).toBe(1);
    // 代表条目是该组最新的一条。
    expect(page.items[1]!.version?.versionNumber).toBe(5);
  });

  it('marks an item read once the reader syncs progress past it, and can filter to unread', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const id = await publishNovel(t, a, '被读过的书');
    t.clock.advance(1000);
    const other = await publishNovel(t, a, '没读过的书', 7);

    const before = FoldedFeedResponseSchema.parse((await t.json('GET', '/api/v1/feed?scope=all', { token: b })).body);
    expect(before.items.every((i) => !i.read)).toBe(true);
    // 匿名恒为未读。
    const anon = FoldedFeedResponseSchema.parse((await t.json('GET', '/api/v1/feed?scope=all')).body);
    expect(anon.items.every((i) => !i.read)).toBe(true);

    t.clock.advance(1000);
    await t.json('PUT', `/api/v1/novels/${id}/progress`, { token: b, body: { chapterIndex: 0, percent: 40 } });
    const after = FoldedFeedResponseSchema.parse((await t.json('GET', '/api/v1/feed?scope=all', { token: b })).body);
    expect(after.items.find((i) => i.novel.id === id)!.read).toBe(true);
    expect(after.items.find((i) => i.novel.id === other)!.read).toBe(false);

    const unread = FoldedFeedResponseSchema.parse((await t.json('GET', '/api/v1/feed?scope=all&unreadOnly=true', { token: b })).body);
    expect(unread.items.map((i) => i.novel.id)).toEqual([other]);
  });

  it('marks a derivative and links back to its source', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const original = await publishNovel(t, a, '原作');
    const fork = await t.json('POST', `/api/v1/novels/${original}/forks`, { token: b, body: {} });
    const deriv = await createNovel(t, b, { title: '续写', license: 'cc-by-sa', allowDerivatives: true, source: { forkId: fork.body.fork.id } } as never);
    await publish(t, b, deriv.id, await makeChapters(1, 9));

    const item = (await t.json('GET', '/api/v1/feed?scope=all')).body.items[0];
    expect(item.kind).toBe('novel_published');
    expect(item.novel.isDerivative).toBe(true);
    expect(item.source.title).toBe('原作');

    // 原作下架后，来源显示为占位。
    await t.json('DELETE', `/api/v1/novels/${original}`, { token: a });
    const after = (await t.json('GET', '/api/v1/feed?scope=all')).body.items;
    expect(after.map((i: any) => i.novel.title)).toEqual(['续写']);
    expect(after[0].source.visibility).toBe('unavailable');
  });

  it('following scope needs a login and only shows followed authors', async () => {
    const t = makeTestApp();
    const { token: a, user: au } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const { token: c } = await t.register('c@example.com');
    await publishNovel(t, a, 'A 的书');
    t.clock.advance(1000);
    await publishNovel(t, b, 'B 的书', 5);

    expect((await t.json('GET', '/api/v1/feed?scope=following')).status).toBe(401);
    expect((await t.json('GET', '/api/v1/feed?scope=following', { token: c })).body.items).toEqual([]);
    await t.json('PUT', `/api/v1/users/${au.id}/follow`, { token: c });
    const mine = await t.json('GET', '/api/v1/feed', { token: c });
    expect(mine.body.items.map((i: any) => i.novel.title)).toEqual(['A 的书']);
    expect((await t.json('GET', '/api/v1/feed?scope=all', { token: c })).body.items.length).toBe(2);
  });

  it('filters by actor for an author page, and hides blocked authors', async () => {
    const t = makeTestApp();
    const { token: a, user: au } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    await publishNovel(t, a, 'A 的书');
    t.clock.advance(1000);
    await publishNovel(t, b, 'B 的书', 5);

    const onlyA = await t.json('GET', `/api/v1/feed?scope=all&actorId=${au.id}`);
    expect(onlyA.body.items.map((i: any) => i.novel.title)).toEqual(['A 的书']);

    await t.json('PUT', `/api/v1/users/${au.id}/block`, { token: b });
    expect((await t.json('GET', '/api/v1/feed?scope=all', { token: b })).body.items.map((i: any) => i.novel.title)).toEqual(['B 的书']);
    expect((await t.json('GET', '/api/v1/feed?scope=all', { token: a })).body.items.map((i: any) => i.novel.title)).toEqual(['A 的书']);
    // 匿名不过滤。
    expect((await t.json('GET', '/api/v1/feed?scope=all')).body.items.length).toBe(2);
  });

  it('hides moderated novels and comes back when moderation is lifted; cursor never repeats', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: admin } = await t.register('admin@example.com');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await publishNovel(t, a, `第 ${i} 本`, i + 1));
      t.clock.advance(1000);
    }
    const first = await t.json('GET', '/api/v1/feed?scope=all&limit=2');
    expect(first.body.items.length).toBe(2);
    const second = await t.json('GET', `/api/v1/feed?scope=all&limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    const seen = [...first.body.items, ...second.body.items].map((i: any) => i.id);
    expect(new Set(seen).size).toBe(3);
    expect(second.body.nextCursor).toBeNull();

    await t.json('PATCH', `/api/v1/admin/novels/${ids[0]}/moderation`, { token: admin, body: { moderationStatus: 'removed' } });
    expect((await t.json('GET', '/api/v1/feed?scope=all')).body.items.length).toBe(2);
    await t.json('PATCH', `/api/v1/admin/novels/${ids[0]}/moderation`, { token: admin, body: { moderationStatus: 'ok' } });
    expect((await t.json('GET', '/api/v1/feed?scope=all')).body.items.length).toBe(3);
  });
});
