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

/** 三章版本，章节级留言用得上。 */
async function setup3() {
  const t = makeTestApp();
  const { token: a } = await t.register('a@example.com');
  const { token: b } = await t.register('b@example.com');
  const n = await createNovel(t, a, { title: '灯下长街' });
  await publish(t, a, n.id, await makeChapters(3));
  return { t, a, b, novelId: n.id };
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
    expect(c.viewer).toEqual({ canDelete: true, canEdit: true, liked: false });
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

    // 举报要求登录（P0-6），且同人同对象去重（§3.3）。
    expect((await t.json('POST', `/api/v1/novels/${novelId}/comments/${c.id}/reports`, { body: { reason: 'spam' } })).status).toBe(401);
    const rep = await t.json('POST', `/api/v1/novels/${novelId}/comments/${c.id}/reports`, { token: admin, body: { reason: 'spam' } });
    expect(rep.status).toBe(201);
    expect(rep.body.report.commentId).toBe(c.id);
    const dup = await t.json('POST', `/api/v1/novels/${novelId}/comments/${c.id}/reports`, { token: admin, body: { reason: 'other' } });
    expect(dup.status).toBe(201);
    expect(dup.body.report.id).toBe(rep.body.report.id);
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
  // ---- §3.6 章节级留言 / 编辑 / 点赞 ----

  it('anchors comments to a chapter and filters by it', async () => {
    const { t, a, b, novelId } = await setup3();
    const c0 = await t.json('POST', `/api/v1/novels/${novelId}/comments`, { token: b, body: { body: '第一章真好', chapterIndex: 0 } });
    expect(c0.status).toBe(201);
    expect(CommentResponseSchema.parse(c0.body).comment.chapterIndex).toBe(0);
    await t.json('POST', `/api/v1/novels/${novelId}/comments`, { token: b, body: { body: '第三章更好', chapterIndex: 2 } });
    await t.json('POST', `/api/v1/novels/${novelId}/comments`, { token: b, body: { body: '整本都好' } });

    const all = CommentListResponseSchema.parse((await t.json('GET', `/api/v1/novels/${novelId}/comments`)).body);
    expect(all.items).toHaveLength(3);
    const ch0 = CommentListResponseSchema.parse((await t.json('GET', `/api/v1/novels/${novelId}/comments?chapter=0`)).body);
    expect(ch0.items.map((c) => c.body)).toEqual(['第一章真好']);
    const novelLevel = CommentListResponseSchema.parse((await t.json('GET', `/api/v1/novels/${novelId}/comments?chapter=novel`)).body);
    expect(novelLevel.items.map((c) => c.body)).toEqual(['整本都好']);

    // 越界的章节下标是参数错误，不是静默落到作品级。
    expect((await t.json('POST', `/api/v1/novels/${novelId}/comments`, { token: b, body: { body: 'x', chapterIndex: 9 } })).status).toBe(400);
    // 回复跟着被回复的那条走，一个线程不会横跨两章。
    const reply = await t.json('POST', `/api/v1/novels/${novelId}/comments`, {
      token: a,
      body: { body: '同感', replyToId: c0.body.comment.id, chapterIndex: 2 },
    });
    expect(reply.body.comment.chapterIndex).toBe(0);
  });

  it('allows editing your own comment inside the 15-minute window only', async () => {
    const { t, a, b, novelId } = await setup3();
    const c = (await post(t, b, novelId, '写错了')).body.comment;
    expect(c.editedAt).toBeNull();
    expect(c.viewer.canEdit).toBe(true);

    expect((await t.json('PATCH', `/api/v1/novels/${novelId}/comments/${c.id}`, { token: a, body: { body: '我来改' } })).status).toBe(403);
    t.clock.advance(60_000);
    const ok = await t.json('PATCH', `/api/v1/novels/${novelId}/comments/${c.id}`, { token: b, body: { body: '改好了' } });
    expect(ok.status).toBe(200);
    const edited = CommentResponseSchema.parse(ok.body).comment;
    expect(edited.body).toBe('改好了');
    expect(edited.editedAt).toBeTruthy();

    t.clock.advance(15 * 60_000);
    const late = await t.json('PATCH', `/api/v1/novels/${novelId}/comments/${c.id}`, { token: b, body: { body: '再改' } });
    expect(late.status).toBe(403);
    // 过了窗口，列表里也不再声称可编辑。
    const list = CommentListResponseSchema.parse((await t.json('GET', `/api/v1/novels/${novelId}/comments`, { token: b })).body);
    expect(list.items[0]!.viewer!.canEdit).toBe(false);
    expect(list.items[0]!.body).toBe('改好了');
  });

  it('likes comments idempotently and reports the viewer state', async () => {
    const { t, a, b, novelId } = await setup3();
    const c = (await post(t, b, novelId, '好看')).body.comment;
    expect(c.likeCount).toBe(0);

    expect((await t.json('PUT', `/api/v1/novels/${novelId}/comments/${c.id}/like`)).status).toBe(401);
    expect((await t.json('PUT', `/api/v1/novels/${novelId}/comments/${c.id}/like`, { token: a })).body).toEqual({ liked: true, likeCount: 1 });
    // 重复点赞不叠加。
    expect((await t.json('PUT', `/api/v1/novels/${novelId}/comments/${c.id}/like`, { token: a })).body).toEqual({ liked: true, likeCount: 1 });

    const seen = CommentListResponseSchema.parse((await t.json('GET', `/api/v1/novels/${novelId}/comments`, { token: a })).body);
    expect(seen.items[0]!.likeCount).toBe(1);
    expect(seen.items[0]!.viewer!.liked).toBe(true);
    const others = CommentListResponseSchema.parse((await t.json('GET', `/api/v1/novels/${novelId}/comments`, { token: b })).body);
    expect(others.items[0]!.viewer!.liked).toBe(false);

    expect((await t.json('DELETE', `/api/v1/novels/${novelId}/comments/${c.id}/like`, { token: a })).body).toEqual({ liked: false, likeCount: 0 });
    expect((await t.json('DELETE', `/api/v1/novels/${novelId}/comments/${c.id}/like`, { token: a })).body).toEqual({ liked: false, likeCount: 0 });
    expect((await t.json('PUT', `/api/v1/novels/${novelId}/comments/nope/like`, { token: a })).status).toBe(404);
  });
});
