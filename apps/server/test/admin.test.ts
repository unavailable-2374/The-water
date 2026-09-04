import { describe, expect, it } from 'bun:test';
import {
  AdminUserListResponseSchema,
  AdminUserResponseSchema,
  CommentResponseSchema,
  ModerationEventListResponseSchema,
} from '@the-water/shared';
import { eq } from 'drizzle-orm';
import { users } from '../src/db/schema';
import { DAY } from '../src/lib/time';
import { createNovel, makeChapters, makeTestApp, publish } from './helpers';

async function setup() {
  const t = makeTestApp();
  const { token: admin, user: adminUser } = await t.register('admin@example.com', '管理员');
  const { token: a, user: au } = await t.register('a@example.com', '作者');
  const { token: b, user: bu } = await t.register('b@example.com', '读者');
  const n = await createNovel(t, a, { title: '灯下长街' });
  await publish(t, a, n.id, await makeChapters(1));
  return { t, admin, adminUser, a, au, b, bu, novelId: n.id };
}

describe('P0-6 封禁生效', () => {
  it('永久封禁后不能写入任何内容，读取不受影响', async () => {
    const { t, admin, b, bu, novelId } = await setup();

    const banned = await t.json('POST', `/api/v1/admin/users/${bu.id}/ban`, { token: admin, body: { reason: '刷广告' } });
    expect(banned.status).toBe(200);
    expect(AdminUserResponseSchema.parse(banned.body).user.status).toBe('banned');

    for (const [method, path, body] of [
      ['POST', `/api/v1/novels/${novelId}/comments`, { body: '还想说' }],
      ['PUT', `/api/v1/novels/${novelId}/like`, undefined],
      ['POST', `/api/v1/novels/${novelId}/forks`, {}],
      ['POST', `/api/v1/novels/${novelId}/reports`, { reason: 'spam' }],
      ['POST', '/api/v1/novels', { title: 'x' }],
    ] as const) {
      const r = await t.json(method, path, body === undefined ? { token: b } : { token: b, body });
      expect(`${method} ${path} => ${r.status}`).toBe(`${method} ${path} => 403`);
      expect(r.body.error.code).toBe('ACCOUNT_SUSPENDED');
      expect(r.body.error.message).toContain('刷广告');
    }
    // 读仍然放行。
    expect((await t.json('GET', '/api/v1/auth/me', { token: b })).status).toBe(200);
    expect((await t.json('GET', `/api/v1/novels/${novelId}`, { token: b })).status).toBe(200);

    const back = await t.json('POST', `/api/v1/admin/users/${bu.id}/unban`, { token: admin });
    expect(AdminUserResponseSchema.parse(back.body).user.status).toBe('active');
    expect((await t.json('PUT', `/api/v1/novels/${novelId}/like`, { token: b })).status).toBe(200);
  });

  it('限期禁言到期后自动恢复，并留下系统审计记录', async () => {
    const { t, admin, b, bu, novelId } = await setup();
    const until = new Date(t.clock.now().getTime() + DAY).toISOString();
    const r = await t.json('POST', `/api/v1/admin/users/${bu.id}/ban`, { token: admin, body: { reason: '刷屏', until } });
    expect(r.body.user.status).toBe('suspended');
    expect(r.body.user.suspendedUntil).toBe(until);

    const blocked = await t.json('POST', `/api/v1/novels/${novelId}/comments`, { token: b, body: { body: '一' } });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.message).toContain('解禁时间');

    t.clock.advance(DAY + 1000);
    expect((await t.json('POST', `/api/v1/novels/${novelId}/comments`, { token: b, body: { body: '二' } })).status).toBe(201);
    const list = await t.json('GET', `/api/v1/admin/users?q=b@example.com`, { token: admin });
    expect(AdminUserListResponseSchema.parse(list.body).items[0]!.status).toBe('active');

    const auto = (await t.json('GET', '/api/v1/admin/moderation-events?action=user_auto_unban', { token: admin })).body.items;
    expect(auto.length).toBe(1);
    expect(auto[0].actorId).toBeNull();
  });

  it('不能封禁自己或其他管理员，解禁时间必须在未来', async () => {
    const { t, admin, adminUser } = await setup();
    const { user: admin2 } = await t.register('admin2@example.com');
    t.deps.db.update(users).set({ role: 'admin' }).where(eq(users.id, admin2.id)).run();

    expect((await t.json('POST', `/api/v1/admin/users/${adminUser.id}/ban`, { token: admin, body: { reason: 'x' } })).status).toBe(400);
    expect((await t.json('POST', `/api/v1/admin/users/${admin2.id}/ban`, { token: admin, body: { reason: 'x' } })).status).toBe(403);
    expect((await t.json('POST', '/api/v1/admin/users/nope/ban', { token: admin, body: { reason: 'x' } })).status).toBe(404);
    const past = new Date(t.clock.now().getTime() - 1000).toISOString();
    expect((await t.json('POST', `/api/v1/admin/users/${admin2.id}/ban`, { token: admin, body: { reason: 'x', until: past } })).status).toBe(403);
    const { user: bu2 } = await t.register('c@example.com');
    expect((await t.json('POST', `/api/v1/admin/users/${bu2.id}/ban`, { token: admin, body: { reason: 'x', until: past } })).status).toBe(400);
  });
});

describe('P0-6 审计日志与管理端点', () => {
  it('每次审核动作都记下操作者', async () => {
    const { t, admin, adminUser, a, b, bu, novelId } = await setup();
    const comment = (await t.json('POST', `/api/v1/novels/${novelId}/comments`, { token: b, body: { body: '好看' } })).body.comment;
    const report = (await t.json('POST', `/api/v1/novels/${novelId}/reports`, { token: b, body: { reason: 'spam' } })).body.report;

    await t.json('PATCH', `/api/v1/admin/novels/${novelId}/moderation`, { token: admin, body: { moderationStatus: 'hidden', note: '待复核' } });
    await t.json('PATCH', `/api/v1/admin/novels/${novelId}/moderation`, { token: admin, body: { moderationStatus: 'ok' } });
    await t.json('POST', `/api/v1/admin/comments/${comment.id}/hide`, { token: admin, body: { note: '广告' } });
    await t.json('POST', `/api/v1/admin/comments/${comment.id}/restore`, { token: admin });
    await t.json('PATCH', `/api/v1/admin/reports/${report.id}`, { token: admin, body: { status: 'dismissed', note: '误报' } });
    await t.json('POST', `/api/v1/admin/users/${bu.id}/ban`, { token: admin, body: { reason: '骚扰' } });

    const page = await t.json('GET', '/api/v1/admin/moderation-events', { token: admin });
    const events = ModerationEventListResponseSchema.parse(page.body).items;
    const byAction = new Map(events.map((e) => [e.action, e]));
    expect([...byAction.keys()].sort()).toEqual(
      ['comment_hide', 'comment_restore', 'novel_hide', 'novel_restore', 'report_dismiss', 'user_ban'].sort(),
    );
    for (const e of events) expect(e.actorId).toBe(adminUser.id);
    expect(byAction.get('novel_hide')!.targetType).toBe('novel');
    expect(byAction.get('novel_hide')!.note).toBe('待复核');
    expect(byAction.get('comment_hide')!.targetId).toBe(comment.id);
    expect(byAction.get('report_dismiss')!.targetId).toBe(report.id);
    expect(byAction.get('user_ban')!.reason).toBe('骚扰');

    // 按对象过滤
    const onNovel = await t.json(`GET`, `/api/v1/admin/moderation-events?targetType=novel&targetId=${novelId}`, { token: admin });
    expect(onNovel.body.items.length).toBe(2);
    const byActor = await t.json(`GET`, `/api/v1/admin/moderation-events?actorId=${adminUser.id}&limit=3`, { token: admin });
    expect(byActor.body.items.length).toBe(3);
    expect(byActor.body.nextCursor).toBeTruthy();
    const nextPage = await t.json(
      'GET',
      `/api/v1/admin/moderation-events?actorId=${adminUser.id}&limit=3&cursor=${encodeURIComponent(byActor.body.nextCursor)}`,
      { token: admin },
    );
    expect(nextPage.body.items.length).toBe(3);
    expect(nextPage.body.items[0].id).not.toBe(byActor.body.items[0].id);

    // 非管理员一律 403
    for (const path of ['/api/v1/admin/users', '/api/v1/admin/moderation-events']) {
      expect((await t.json('GET', path, { token: a })).status).toBe(403);
      expect((await t.json('GET', path)).status).toBe(401);
    }
  });

  it('用户检索支持关键词与状态筛选并分页', async () => {
    const { t, admin, bu } = await setup();
    await t.json('POST', `/api/v1/admin/users/${bu.id}/ban`, { token: admin, body: { reason: '刷屏' } });

    const all = await t.json('GET', '/api/v1/admin/users?limit=2', { token: admin });
    expect(AdminUserListResponseSchema.parse(all.body).items.length).toBe(2);
    expect(all.body.nextCursor).toBeTruthy();
    const next = await t.json('GET', `/api/v1/admin/users?limit=2&cursor=${encodeURIComponent(all.body.nextCursor)}`, { token: admin });
    expect(next.body.items.length).toBe(1);

    const bannedOnly = await t.json('GET', '/api/v1/admin/users?status=banned', { token: admin });
    expect(bannedOnly.body.items.map((u: { id: string }) => u.id)).toEqual([bu.id]);
    const byName = await t.json('GET', '/api/v1/admin/users?q=读者', { token: admin });
    expect(byName.body.items.map((u: { id: string }) => u.id)).toEqual([bu.id]);
    const byEmail = await t.json('GET', '/api/v1/admin/users?q=B@EXAMPLE', { token: admin });
    expect(byEmail.body.items.map((u: { id: string }) => u.id)).toEqual([bu.id]);
    expect((await t.json('GET', '/api/v1/admin/users?q=nobody', { token: admin })).body.items).toEqual([]);
  });

  it('按 id 隐藏 / 恢复留言', async () => {
    const { t, admin, b, novelId } = await setup();
    const comment = (await t.json('POST', `/api/v1/novels/${novelId}/comments`, { token: b, body: { body: '好看' } })).body.comment;

    const hidden = await t.json('POST', `/api/v1/admin/comments/${comment.id}/hide`, { token: admin });
    expect(hidden.status).toBe(200);
    expect(CommentResponseSchema.parse(hidden.body).comment.status).toBe('hidden');
    expect((await t.json('GET', `/api/v1/novels/${novelId}/comments`)).body.items).toEqual([]);

    const back = await t.json('POST', `/api/v1/admin/comments/${comment.id}/restore`, { token: admin });
    expect(back.body.comment.status).toBe('ok');
    expect((await t.json('GET', `/api/v1/novels/${novelId}/comments`)).body.items.length).toBe(1);
    expect((await t.json('POST', '/api/v1/admin/comments/nope/hide', { token: admin })).status).toBe(404);
    expect((await t.json('POST', `/api/v1/admin/comments/${comment.id}/hide`, { token: b })).status).toBe(403);
  });
});
