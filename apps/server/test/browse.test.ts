import { describe, expect, it } from 'bun:test';
import { NovelListResponseSchema, StorylineResponseSchema, ViewResponseSchema } from '@the-water/shared';
import { DAY } from '../src/lib/time';
import { createNovel, makeChapters, makeTestApp, publish } from './helpers';

async function seedPublished(t: ReturnType<typeof makeTestApp>, token: string, n: number, opts: Parameters<typeof createNovel>[2] = {}) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const novel = await createNovel(t, token, { title: `作品${i + 1}`, tags: [i % 2 ? '玄幻' : '言情'], ...opts });
    await publish(t, token, novel.id, await makeChapters(2, i + 1, 200));
    ids.push(novel.id);
    t.clock.advance(1000);
  }
  return ids;
}

describe('browse', () => {
  it('lists only public + ok + committed novels; unlisted reachable by id only; hidden/removed/deleted excluded', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const { token: admin } = await t.register('admin@example.com');
    const [pub, unlisted, hidden, removed, deleted] = await seedPublished(t, token, 5);
    await createNovel(t, token, { title: '未发布' });
    await t.json('PATCH', `/api/v1/novels/${unlisted}`, { token, body: { visibility: 'unlisted' } });
    expect((await t.json('PATCH', `/api/v1/admin/novels/${hidden}/moderation`, { token, body: { moderationStatus: 'hidden' } })).status).toBe(403);
    expect((await t.json('PATCH', `/api/v1/admin/novels/${hidden}/moderation`, { token: admin, body: { moderationStatus: 'hidden', note: '待复核' } })).status).toBe(200);
    await t.json('PATCH', `/api/v1/admin/novels/${removed}/moderation`, { token: admin, body: { moderationStatus: 'removed' } });
    expect((await t.json('DELETE', `/api/v1/novels/${deleted}`, { token })).status).toBe(200);

    const list = await t.json('GET', '/api/v1/novels');
    expect(list.status).toBe(200);
    const page = NovelListResponseSchema.parse(list.body);
    expect(page.items.map((n) => n.id)).toEqual([pub!]);

    expect((await t.json('GET', `/api/v1/novels/${unlisted}`)).status).toBe(200);
    expect((await t.json('GET', `/api/v1/novels/${hidden}`)).status).toBe(404);
    expect((await t.json('GET', `/api/v1/novels/${hidden}`, { token })).status).toBe(200);
    expect((await t.json('GET', `/api/v1/novels/${removed}`)).status).toBe(404);
    expect((await t.json('GET', `/api/v1/novels/${removed}`, { token })).status).toBe(200); // 作者仍可见状态
    expect((await t.json('GET', `/api/v1/novels/${deleted}`)).status).toBe(404);
    expect((await t.json('GET', `/api/v1/novels/${deleted}`, { token })).status).toBe(404);
    expect((await t.json('GET', `/api/v1/novels/${deleted}`, { token: admin })).status).toBe(200);
    // 作者自己的列表不含已删除
    const mine = await t.json('GET', '/api/v1/me/novels', { token });
    expect(mine.body.items.length).toBe(5);
  });

  it('cursor pagination is stable across inserts and covers everything exactly once', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const ids = await seedPublished(t, token, 7);
    const p1 = await t.json('GET', '/api/v1/novels?limit=3');
    expect(p1.body.items.length).toBe(3);
    expect(p1.body.nextCursor).toBeTruthy();
    // 插入新作品（排在最前）不影响后续页
    await seedPublished(t, token, 1);
    const p2 = await t.json('GET', `/api/v1/novels?limit=3&cursor=${encodeURIComponent(p1.body.nextCursor)}`);
    const p3 = await t.json('GET', `/api/v1/novels?limit=3&cursor=${encodeURIComponent(p2.body.nextCursor)}`);
    expect(p3.body.nextCursor).toBeNull();
    const seen = [...p1.body.items, ...p2.body.items, ...p3.body.items].map((n: any) => n.id);
    expect(seen).toEqual([...ids].reverse());
    expect(new Set(seen).size).toBe(7);
    expect((await t.json('GET', '/api/v1/novels?cursor=%%%bad')).status).toBe(400);
  });

  it('filters: tag, license, writingStatus, allowDerivatives, originalsOnly, q; sorts: popular/likes/forks', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const ids = await seedPublished(t, token, 4);
    await t.json('PATCH', `/api/v1/novels/${ids[0]}`, { token, body: { writingStatus: 'completed', license: 'cc0', summary: '一个独特的关键词甲乙丙' } });
    await t.json('PATCH', `/api/v1/novels/${ids[1]}`, { token, body: { allowDerivatives: false } });

    const byTag = await t.json('GET', '/api/v1/novels?tag=玄幻');
    expect(byTag.body.items.map((n: any) => n.id).sort()).toEqual([ids[1], ids[3]].sort());
    expect((await t.json('GET', '/api/v1/novels?license=cc0')).body.items.map((n: any) => n.id)).toEqual([ids[0]]);
    expect((await t.json('GET', '/api/v1/novels?writingStatus=completed')).body.items.map((n: any) => n.id)).toEqual([ids[0]]);
    expect((await t.json('GET', '/api/v1/novels?allowDerivatives=false')).body.items.map((n: any) => n.id)).toEqual([ids[1]]);
    expect((await t.json('GET', '/api/v1/novels?allowDerivatives=true')).body.items.length).toBe(3);
    expect((await t.json('GET', '/api/v1/novels?q=甲乙丙')).body.items.map((n: any) => n.id)).toEqual([ids[0]]);
    expect((await t.json('GET', '/api/v1/novels?q=作品3')).body.items.map((n: any) => n.id)).toEqual([ids[2]]);
    expect((await t.json('GET', '/api/v1/novels?q=%25')).body.items.length).toBe(0); // LIKE 通配符被转义

    // 二创 + originalsOnly
    const { token: b } = await t.register('b@example.com');
    const fork = await t.json('POST', `/api/v1/novels/${ids[2]}/forks`, { token: b, body: {} });
    const deriv = await createNovel(t, b, { title: '二创作品', source: { forkId: fork.body.fork.id } });
    await publish(t, b, deriv.id, await makeChapters(1, 99, 100));
    expect((await t.json('GET', '/api/v1/novels')).body.items.length).toBe(5);
    expect((await t.json('GET', '/api/v1/novels?originalsOnly=1')).body.items.length).toBe(4);
    expect((await t.json('GET', '/api/v1/novels?sort=forks')).body.items[0].id).toBe(ids[2]);

    // 点赞与浏览排序
    await t.json('PUT', `/api/v1/novels/${ids[1]}/like`, { token: b });
    expect((await t.json('GET', '/api/v1/novels?sort=likes')).body.items[0].id).toBe(ids[1]);
    await t.json('POST', `/api/v1/novels/${ids[3]}/view`, { headers: { 'X-Client-Id': 'client-aaaaaaaa' } });
    expect((await t.json('GET', '/api/v1/novels?sort=popular')).body.items[0].id).toBe(ids[3]);
    // popular 分页游标
    const pp = await t.json('GET', '/api/v1/novels?sort=popular&limit=2');
    const pp2 = await t.json('GET', `/api/v1/novels?sort=popular&limit=2&cursor=${encodeURIComponent(pp.body.nextCursor)}`);
    const all = [...pp.body.items, ...pp2.body.items].map((n: any) => n.id);
    expect(new Set(all).size).toBe(4);
    expect((await t.json('GET', '/api/v1/novels?sort=nope')).status).toBe(400);
  });

  it('view dedup per viewer per day', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const [id] = await seedPublished(t, token, 1);
    const view = (headers: Record<string, string> = {}, tok?: string) => t.json('POST', `/api/v1/novels/${id}/view`, { headers, token: tok });
    const v1 = await view({ 'X-Client-Id': 'client-00000001' });
    expect(v1.status).toBe(200);
    expect(ViewResponseSchema.parse(v1.body)).toEqual({ viewCount: 1, counted: true });
    expect((await view({ 'X-Client-Id': 'client-00000001' })).body).toEqual({ viewCount: 1, counted: false });
    expect((await view({ 'X-Client-Id': 'client-00000002' })).body).toEqual({ viewCount: 2, counted: true });
    // 登录用户以 user 为键
    expect((await view({}, token)).body).toEqual({ viewCount: 3, counted: true });
    expect((await view({}, token)).body).toEqual({ viewCount: 3, counted: false });
    // 次日重新计数
    t.clock.advance(DAY);
    expect((await view({ 'X-Client-Id': 'client-00000001' })).body).toEqual({ viewCount: 4, counted: true });
    const detail = await t.json('GET', `/api/v1/novels/${id}`);
    expect(detail.body.novel.viewCount).toBe(4);
  });

  it('storyline + bible endpoint and chapters paging', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const novel = await createNovel(t, token);
    const chs = await makeChapters(12, 3, 150);
    await publish(t, token, novel.id, chs);
    const s = await t.json('GET', `/api/v1/novels/${novel.id}/versions/current/storyline`);
    expect(s.status).toBe(200);
    const parsed = StorylineResponseSchema.parse(s.body);
    expect(parsed.storyline.premise).toBe('一个关于灯火与远方的故事');
    expect(parsed.bible).toBeNull();
    expect(parsed.storylineHash).toMatch(/^[0-9a-f]{64}$/);
    const page = await t.json('GET', `/api/v1/novels/${novel.id}/versions/current/chapters?from=10&limit=5`);
    expect(page.body.total).toBe(12);
    expect(page.body.items.map((c: any) => c.index)).toEqual([10, 11]);
    expect((await t.json('GET', `/api/v1/novels/${novel.id}/versions/current/chapters/12`)).status).toBe(404);
    expect((await t.json('GET', `/api/v1/novels/${novel.id}/versions/current/chapters/abc`)).status).toBe(400);
    expect((await t.json('GET', `/api/v1/novels/${novel.id}/versions/nonexistent/chapters`)).status).toBe(404);
  });
});
