import { describe, expect, it } from 'bun:test';
import { CommentListResponseSchema, CommentResponseSchema } from '@the-water/shared';
import { createNovel, makeChapters, makeTestApp, publish } from './helpers';

async function setup() {
  const t = makeTestApp();
  const { token: a, user: au } = await t.register('a@example.com');
  const { token: b, user: bu } = await t.register('b@example.com');
  const n = await createNovel(t, a, { title: '灯下长街' });
  await publish(t, a, n.id, await makeChapters(1));
  return { t, a, b, au, bu, novelId: n.id };
}

const post = (t: any, token: string, novelId: string, body: string, replyToId?: string) =>
  t.json('POST', `/api/v1/novels/${novelId}/comments`, { token, body: replyToId ? { body, replyToId } : { body } });

describe('comments', () => {
  it('posts top-level comments and counts them on the novel', async () => {
    const { t, b, novelId } = await setup();
    expect((await post(t, '', novelId, '好看')).status).toBe(401);
    const r = await post(t, b, novelId, '看哭了');
    expect(r.status).toBe(201);
    const c = CommentResponseSchema.parse(r.body).comment;
    expect(c.body).toBe('看哭了');
    expect(c.parentId).toBeNull();
    expect(c.viewer).toEqual({ canDelete: true });
    expect(c.author.handle).toBeTruthy();
    expect((await t.json('GET', `/api/v1/novels/${novelId}`)).body.novel.commentCount).toBe(1);
    expect((await post(t, b, novelId, '   ')).status).toBe(400);
    expect((await post(t, b, novelId, '字'.repeat(2001))).status).toBe(400);
  });

  it('normalizes replies to two levels and orders them oldest first', async () => {
    const { t, a, b, novelId } = await setup();
    const top = (await post(t, b, novelId, '顶层')).body.comment;
    t.clock.advance(1000);
    const reply1 = (await post(t, a, novelId, '谢谢', top.id)).body.comment;
    t.clock.advance(1000);
    // 回复"回复"时，parentId 仍归到顶层。
    const reply2 = (await post(t, b, novelId, '再说一句', reply1.id)).body.comment;
    expect(reply1.parentId).toBe(top.id);
    expect(reply2.parentId).toBe(top.id);
    expect(reply2.replyToId).toBe(reply1.id);
    expect(reply2.replyToName).toBeTruthy();

    const list = await t.json('GET', `/api/v1/novels/${novelId}/comments`);
    const page = CommentListResponseSchema.parse(list.body);
    expect(page.items.map((c) => c.id)).toEqual([top.id]);
    expect(page.items[0]!.replyCount).toBe(2);

    const replies = await t.json('GET', `/api/v1/novels/${novelId}/comments/${top.id}/replies`);
    expect(replies.body.items.map((c: any) => c.id)).toEqual([reply1.id, reply2.id]);
    expect((await t.json('GET', `/api/v1/novels/${novelId}`)).body.novel.commentCount).toBe(3);
  });

  it('lets the commenter, the novel author and admins delete; leaves a tombstone when replies exist', async () => {
    const { t, a, b, novelId } = await setup();
    const { token: c } = await t.register('c@example.com');
    const lonely = (await post(t, b, novelId, '独立留言')).body.comment;
    const top = (await post(t, b, novelId, '有回复的')).body.comment;
    await post(t, a, novelId, '回复', top.id);

    expect((await t.json('DELETE', `/api/v1/novels/${novelId}/comments/${lonely.id}`, { token: c })).status).toBe(403);
    expect((await t.json('DELETE', `/api/v1/novels/${novelId}/comments/${lonely.id}`, { token: b })).status).toBe(200);
    // 没有回复的顶层删掉后就从列表里消失。
    expect((await t.json('GET', `/api/v1/novels/${novelId}/comments`)).body.items.map((x: any) => x.id)).toEqual([top.id]);
    // 作者可以删别人留在自己作品下的话。
    expect((await t.json('DELETE', `/api/v1/novels/${novelId}/comments/${top.id}`, { token: a })).status).toBe(200);
    const after = (await t.json('GET', `/api/v1/novels/${novelId}/comments`)).body.items;
    expect(after.length).toBe(1);
    expect(after[0]).toMatchObject({ id: top.id, status: 'deleted', body: '', replyCount: 1 });
    expect((await t.json('GET', `/api/v1/novels/${novelId}`)).body.novel.commentCount).toBe(1);
    // 重复删除按不存在处理。
    expect((await t.json('DELETE', `/api/v1/novels/${novelId}/comments/${top.id}`, { token: a })).status).toBe(404);
    // 不能回复已删除的留言。
    expect((await post(t, b, novelId, '还在吗', top.id)).status).toBe(404);
  });

  it('hides comments between blocked users and refuses new ones', async () => {
    const { t, a, b, au, novelId } = await setup();
    const { token: c } = await t.register('c@example.com');
    const fromB = (await post(t, b, novelId, 'B 的留言')).body.comment;
    await post(t, c, novelId, 'C 的留言');

    await t.json('PUT', `/api/v1/users/${au.id}/block`, { token: b });
    expect((await post(t, b, novelId, '还想说')).body.error.code).toBe('BLOCKED');
    // 互相看不到对方的留言，第三方照常可见。
    expect((await t.json('GET', `/api/v1/novels/${novelId}/comments`, { token: a })).body.items.map((x: any) => x.id)).not.toContain(fromB.id);
    expect((await t.json('GET', `/api/v1/novels/${novelId}/comments`, { token: c })).body.items.length).toBe(2);
    expect((await t.json('GET', `/api/v1/novels/${novelId}/comments`)).body.items.length).toBe(2);
  });

  it('reports a comment and lets an admin hide then restore it', async () => {
    const { t, b, novelId } = await setup();
    const { token: admin } = await t.register('admin@example.com');
    const c = (await post(t, b, novelId, '广告广告')).body.comment;

    const rep = await t.json('POST', `/api/v1/novels/${novelId}/comments/${c.id}/reports`, { body: { reason: 'spam' } });
    expect(rep.status).toBe(201);
    expect(rep.body.report.commentId).toBe(c.id);
    expect((await t.json('GET', '/api/v1/admin/reports?status=open', { token: admin })).body.items.length).toBe(1);

    const hidden = await t.json('PATCH', `/api/v1/admin/novels/${novelId}/comments/${c.id}`, { token: admin, body: { status: 'hidden' } });
    expect(hidden.status).toBe(200);
    expect(hidden.body.comment.status).toBe('hidden');
    expect((await t.json('GET', `/api/v1/novels/${novelId}/comments`)).body.items).toEqual([]);
    expect((await t.json('GET', '/api/v1/admin/reports?status=open', { token: admin })).body.items.length).toBe(0);

    const back = await t.json('PATCH', `/api/v1/admin/novels/${novelId}/comments/${c.id}`, { token: admin, body: { status: 'ok' } });
    expect(back.body.comment.status).toBe('ok');
    expect((await t.json('GET', `/api/v1/novels/${novelId}/comments`)).body.items.length).toBe(1);
    expect((await t.json('PATCH', `/api/v1/admin/novels/${novelId}/comments/${c.id}`, { token: b, body: { status: 'hidden' } })).status).toBe(403);
  });

  it('refuses comments on novels that are not published', async () => {
    const { t, a, b } = await setup();
    const draft = await createNovel(t, a, { title: '还没发布' });
    expect((await post(t, b, draft.id, '想看')).status).toBe(404);
    expect((await post(t, b, 'nope', '想看')).status).toBe(404);
  });

  it('rate limits comment bursts (every attempt counts, including rejected ones)', async () => {
    const t = makeTestApp({ rateLimits: { comment: { max: 2, windowMs: 60_000 } } });
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const n = await createNovel(t, a, { title: '发布了' });
    await publish(t, a, n.id, await makeChapters(1, 4));
    expect((await post(t, b, n.id, '一')).status).toBe(201);
    expect((await post(t, b, n.id, '二')).status).toBe(201);
    const limited = await post(t, b, n.id, '三');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });
});
