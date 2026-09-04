/**
 * §3.1 站内通知：事件源（关注 / 喜欢 / 留言 / 派生 / 徽章 / 审核）到出口（列表、未读数、已读）的端到端覆盖。
 */
import { describe, expect, it } from 'bun:test';
import { NotificationListResponseSchema } from '@the-water/shared';
import { createNovel, makeChapters, makeTestApp, publish, type TestApp } from './helpers';

async function setup() {
  const t = makeTestApp();
  const { token: a, user: au } = await t.register('a@example.com', '林晚');
  const { token: b, user: bu } = await t.register('b@example.com', '陈舟');
  const admin = (await t.register('admin@example.com', '管理员')).token;
  await t.json('PATCH', '/api/v1/auth/me', { token: a, body: { handle: 'linwan' } });
  await t.json('PATCH', '/api/v1/auth/me', { token: b, body: { handle: 'chenzhou' } });
  const n = await createNovel(t, a, { title: '灯下长街' });
  await publish(t, a, n.id, await makeChapters(3));
  return { t, a, b, admin, au, bu, novelId: n.id };
}

async function inbox(t: TestApp, token: string, query = '') {
  const r = await t.json('GET', `/api/v1/me/notifications${query}`, { token });
  expect(r.status).toBe(200);
  return NotificationListResponseSchema.parse(r.body);
}

const kinds = (page: { items: { kind: string }[] }) => page.items.map((i) => i.kind);

describe('notifications', () => {
  it('requires auth', async () => {
    const { t } = await setup();
    expect((await t.json('GET', '/api/v1/me/notifications')).status).toBe(401);
    expect((await t.json('GET', '/api/v1/me/notifications/unread-count')).status).toBe(401);
    expect((await t.json('POST', '/api/v1/me/notifications/read', { body: { all: true } })).status).toBe(401);
  });

  it('notifies on follow, like, fork and comment — and never notifies yourself', async () => {
    const { t, a, b, au, novelId } = await setup();

    // 自赞、自评不产生通知。
    await t.json('PUT', `/api/v1/novels/${novelId}/like`, { token: a });
    await t.json('POST', `/api/v1/novels/${novelId}/comments`, { token: a, body: { body: '自言自语' } });
    expect((await inbox(t, a)).items.filter((i) => i.kind === 'liked' || i.kind === 'commented')).toEqual([]);

    t.clock.advance(1000);
    await t.json('PUT', `/api/v1/users/${au.id}/follow`, { token: b });
    t.clock.advance(1000);
    await t.json('PUT', `/api/v1/novels/${novelId}/like`, { token: b });
    t.clock.advance(1000);
    await t.json('POST', `/api/v1/novels/${novelId}/comments`, { token: b, body: { body: '看哭了' } });
    t.clock.advance(1000);
    await t.json('POST', `/api/v1/novels/${novelId}/forks`, { token: b, body: {} });

    const page = await inbox(t, a);
    // 派生还会顺带触发「开枝散叶」徽章，所以只断言这四件事都在，且按时间倒序。
    expect(kinds(page).filter((k) => k !== 'badge')).toEqual(['forked', 'commented', 'liked', 'followed']);
    const liked = page.items.find((i) => i.kind === 'liked')!;
    expect(liked.title).toBe('陈舟 喜欢了《灯下长街》');
    expect(liked.actor).toMatchObject({ handle: 'chenzhou', displayName: '陈舟' });
    expect(liked.novelId).toBe(novelId);
    const commented = page.items.find((i) => i.kind === 'commented')!;
    expect(commented.body).toBe('看哭了');
    // 留言类通知带上作品 id，客户端点开就能落到那本书。
    expect(commented.novelId).toBe(novelId);
    expect(page.unreadCount).toBe(page.items.length);
  });

  it('dedupes repeated events through dedupeKey', async () => {
    const { t, a, b, novelId } = await setup();
    await t.json('PUT', `/api/v1/novels/${novelId}/like`, { token: b });
    await t.json('DELETE', `/api/v1/novels/${novelId}/like`, { token: b });
    t.clock.advance(60_000);
    await t.json('PUT', `/api/v1/novels/${novelId}/like`, { token: b });
    expect((await inbox(t, a)).items.filter((i) => i.kind === 'liked')).toHaveLength(1);
  });

  it('notifies the reply target and the @mentioned user without double-notifying', async () => {
    const { t, a, b, novelId } = await setup();
    const top = (await t.json('POST', `/api/v1/novels/${novelId}/comments`, { token: b, body: { body: '顶层' } })).body.comment;
    t.clock.advance(1000);
    // a 回复 b 并 @ 了 b：b 只该收到一条（回复优先于提及）。
    await t.json('POST', `/api/v1/novels/${novelId}/comments`, {
      token: a,
      body: { body: '@chenzhou 谢谢你', replyToId: top.id },
    });
    const bInbox = await inbox(t, b);
    expect(kinds(bInbox)).toEqual(['replied']);
    expect(bInbox.items[0]!.title).toBe('林晚 回复了你在《灯下长街》的留言');

    // 第三个人被 @：收到 mentioned。
    const { token: c } = await t.register('c@example.com', '路人');
    await t.json('PATCH', '/api/v1/auth/me', { token: c, body: { handle: 'luren' } });
    t.clock.advance(1000);
    await t.json('POST', `/api/v1/novels/${novelId}/comments`, { token: b, body: { body: '喊一声 @luren 来看' } });
    expect(kinds(await inbox(t, c))).toEqual(['mentioned']);
    // 作品作者收到的是 commented，不会因为同一条留言收两遍。
    expect((await inbox(t, a)).items.filter((i) => i.refId === top.id)).toHaveLength(1);
  });

  it('notifies on badges', async () => {
    const { t, a } = await setup();
    const badge = (await inbox(t, a)).items.find((i) => i.kind === 'badge');
    // 发布第一本书就拿到「初次登台」。
    expect(badge?.refId).toBe('first_publish');
    expect(badge?.title).toBe('获得徽章「初次登台」');
    expect(badge?.actor).toBeNull();
  });

  it('notifies the author when a novel or a comment is moderated', async () => {
    const { t, a, b, admin, novelId } = await setup();
    const c = (await t.json('POST', `/api/v1/novels/${novelId}/comments`, { token: b, body: { body: '有问题的留言' } })).body.comment;
    t.clock.advance(1000);
    await t.json('PATCH', `/api/v1/admin/novels/${novelId}/moderation`, { token: admin, body: { moderationStatus: 'hidden', note: '涉嫌抄袭' } });
    t.clock.advance(1000);
    await t.json('PATCH', `/api/v1/admin/novels/${novelId}/comments/${c.id}`, { token: admin, body: { status: 'hidden' } });

    const authorInbox = await inbox(t, a);
    const mod = authorInbox.items.find((i) => i.kind === 'moderation_novel')!;
    expect(mod.title).toBe('《灯下长街》已被暂时隐藏，正在人工复核');
    expect(mod.body).toBe('涉嫌抄袭');
    expect(mod.actor).toBeNull();
    expect(kinds(await inbox(t, b))).toContain('moderation_comment');

    // 恢复是另一件事，作者应该再收到一条。
    t.clock.advance(1000);
    await t.json('PATCH', `/api/v1/admin/novels/${novelId}/moderation`, { token: admin, body: { moderationStatus: 'ok' } });
    expect((await inbox(t, a)).items.filter((i) => i.kind === 'moderation_novel')).toHaveLength(2);
  });

  it('paginates, filters unread and marks read in bulk', async () => {
    const { t, a, b, au, novelId } = await setup();
    await t.json('PUT', `/api/v1/users/${au.id}/follow`, { token: b });
    t.clock.advance(1000);
    await t.json('PUT', `/api/v1/novels/${novelId}/like`, { token: b });
    t.clock.advance(1000);
    await t.json('POST', `/api/v1/novels/${novelId}/comments`, { token: b, body: { body: '很好看' } });

    const first = await inbox(t, a, '?limit=2');
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await inbox(t, a, `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.items.length).toBeGreaterThan(0);
    const ids = new Set([...first.items, ...second.items].map((i) => i.id));
    expect(ids.size).toBe(first.items.length + second.items.length);

    const before = (await t.json('GET', '/api/v1/me/notifications/unread-count', { token: a })).body.unreadCount;
    expect(before).toBeGreaterThanOrEqual(4);

    // 标一条已读。
    const one = await t.json('POST', '/api/v1/me/notifications/read', { token: a, body: { ids: [first.items[0]!.id] } });
    expect(one.body).toEqual({ updated: 1, unreadCount: before - 1 });
    // 重复标同一条不再计数。
    expect((await t.json('POST', '/api/v1/me/notifications/read', { token: a, body: { ids: [first.items[0]!.id] } })).body.updated).toBe(0);

    const unread = await inbox(t, a, '?filter=unread');
    expect(unread.items.every((i) => i.readAt === null)).toBe(true);
    expect(unread.items).toHaveLength(before - 1);

    const all = await t.json('POST', '/api/v1/me/notifications/read', { token: a, body: { all: true } });
    expect(all.body).toEqual({ updated: before - 1, unreadCount: 0 });
    expect((await inbox(t, a, '?filter=unread')).items).toEqual([]);
    expect((await inbox(t, a)).items.every((i) => i.readAt !== null)).toBe(true);

    // 空参数是参数错误；别人的通知 id 标不动。
    expect((await t.json('POST', '/api/v1/me/notifications/read', { token: a, body: {} })).status).toBe(400);
    expect((await t.json('POST', '/api/v1/me/notifications/read', { token: b, body: { ids: [...ids] } })).body.updated).toBe(0);
  });
});
