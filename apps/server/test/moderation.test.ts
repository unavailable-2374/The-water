import { describe, expect, it } from 'bun:test';
import { testEnv } from '../src/env';
import { createRulesModerator } from '../src/lib/moderation';
import { moderateProfileFields } from '../src/modules/users/service';
import { createNovel, makeChapters, makeTestApp, publish } from './helpers';

/** 种子词表里的一条，用来触发规则引擎。 */
const BAD = '办证刻章';

function appWithRules() {
  return makeTestApp({ moderator: createRulesModerator(testEnv()) });
}

async function events(t: ReturnType<typeof appWithRules>, adminToken: string) {
  const r = await t.json('GET', '/api/v1/admin/moderation-events', { token: adminToken });
  return r.body.items as Array<{ action: string; actorId: string | null; targetType: string; targetId: string; reason: string | null }>;
}

describe('P0-2 审核扩展到所有写入路径', () => {
  it('拒绝含违禁词的作品元数据，并记一条 auto_reject', async () => {
    const t = appWithRules();
    const { token: a } = await t.register('a@example.com');
    const { token: admin } = await t.register('admin@example.com');
    const n = await createNovel(t, a, { title: '灯下长街' });

    const bad = await t.json('PATCH', `/api/v1/novels/${n.id}`, { token: a, body: { title: BAD } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('CONTENT_REJECTED');
    expect(bad.body.error.message).toContain('标题');
    // 标题没有被改掉。
    expect((await t.json('GET', `/api/v1/novels/${n.id}`, { token: a })).body.novel.title).toBe('灯下长街');

    const summary = await t.json('PATCH', `/api/v1/novels/${n.id}`, { token: a, body: { summary: `正常开头${BAD}` } });
    expect(summary.status).toBe(400);
    const tags = await t.json('PATCH', `/api/v1/novels/${n.id}`, { token: a, body: { tags: ['言情', BAD] } });
    expect(tags.status).toBe(400);
    // 干净的修改照常通过。
    expect((await t.json('PATCH', `/api/v1/novels/${n.id}`, { token: a, body: { title: '雪夜' } })).status).toBe(200);

    const log = await events(t, admin);
    const auto = log.filter((e) => e.action === 'auto_reject');
    expect(auto.length).toBe(3);
    expect(auto[0]!.actorId).toBeNull();
    expect(auto[0]!.targetType).toBe('novel');
    expect(auto[0]!.targetId).toBe(n.id);
    expect(auto[0]!.reason).toContain('违禁词');
  });

  it('创建作品时的标题 / 简介同样过审', async () => {
    const t = appWithRules();
    const { token: a } = await t.register('a@example.com');
    const r = await t.json('POST', '/api/v1/novels', {
      token: a,
      body: { title: BAD, summary: '', tags: [], language: 'zh-CN', writingStatus: 'ongoing', license: 'cc-by-sa', allowDerivatives: true, visibility: 'public' },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('CONTENT_REJECTED');
    expect((await t.json('GET', '/api/v1/me/novels', { token: a })).body.items.length).toBe(0);
  });

  it('拦截含违禁词的留言，留言不入库', async () => {
    const t = appWithRules();
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const n = await createNovel(t, a, { title: '灯下长街' });
    await publish(t, a, n.id, await makeChapters(1));

    const bad = await t.json('POST', `/api/v1/novels/${n.id}/comments`, { token: b, body: { body: `快来${BAD}` } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('CONTENT_REJECTED');
    expect((await t.json('GET', `/api/v1/novels/${n.id}/comments`)).body.items.length).toBe(0);
    expect((await t.json('GET', `/api/v1/novels/${n.id}`)).body.novel.commentCount).toBe(0);

    expect((await t.json('POST', `/api/v1/novels/${n.id}/comments`, { token: b, body: { body: '好看' } })).status).toBe(201);
  });

  it('moderateProfileFields 可复用在昵称 / 简介 / handle 上', async () => {
    const t = appWithRules();
    const { user } = await t.register('a@example.com');
    await expect(moderateProfileFields(t.deps, { displayName: '张三', bio: '写故事的人' }, user.id)).resolves.toBeUndefined();
    await expect(moderateProfileFields(t.deps, { displayName: BAD }, user.id)).rejects.toThrow('内容未通过审核');
    await expect(moderateProfileFields(t.deps, { bio: `简介里也有${BAD}` }, user.id)).rejects.toThrow('内容未通过审核');
    await expect(moderateProfileFields(t.deps, { handle: BAD }, user.id)).rejects.toThrow('内容未通过审核');

    const { token: admin } = await t.register('admin@example.com');
    const auto = (await events(t, admin)).filter((e) => e.action === 'auto_reject');
    expect(auto.length).toBe(3);
    expect(auto.every((e) => e.targetType === 'user' && e.targetId === user.id)).toBe(true);
  });
});
