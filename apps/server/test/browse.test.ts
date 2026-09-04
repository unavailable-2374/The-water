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

  it('计数排序的游标带上稳定次键：计数相同的作品按发布时间倒序，翻页不重不漏（§4.6）', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    // 5 本作品，likeCount 全是 0 —— 主键完全打平，全靠次键定序。
    const ids = await seedPublished(t, token, 5);
    const newestFirst = [...ids].reverse();

    const one = await t.json('GET', '/api/v1/novels?sort=likes&limit=2');
    expect(one.body.items.map((n: any) => n.id)).toEqual(newestFirst.slice(0, 2));

    // 翻页途中给第一页里的作品点赞：它的计数变了，但已经翻过去了，不该再出现。
    await t.json('PUT', `/api/v1/novels/${ids[4]}/like`, { token: b });

    const two = await t.json('GET', `/api/v1/novels?sort=likes&limit=2&cursor=${encodeURIComponent(one.body.nextCursor)}`);
    const three = await t.json('GET', `/api/v1/novels?sort=likes&limit=2&cursor=${encodeURIComponent(two.body.nextCursor)}`);
    const seen = [...one.body.items, ...two.body.items, ...three.body.items].map((n: any) => n.id);
    expect(seen).toEqual(newestFirst);
    expect(new Set(seen).size).toBe(5);
    expect(three.body.nextCursor).toBeNull();

    // latest 的游标格式没变，旧客户端存下来的游标继续可用。
    const latest = await t.json('GET', '/api/v1/novels?limit=2');
    const latest2 = await t.json('GET', `/api/v1/novels?limit=2&cursor=${encodeURIComponent(latest.body.nextCursor)}`);
    expect([...latest.body.items, ...latest2.body.items].map((n: any) => n.id)).toEqual(newestFirst.slice(0, 4));
  });

  it('偏移分页给网页用：同一套可见性与筛选条件，外加总数与页码', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const ids = await seedPublished(t, token, 5);
    const { browseNovelsOffset } = await import('../src/modules/browse/service');

    const p1 = browseNovelsOffset(t.deps, { sort: 'latest' }, 1, 2);
    expect(p1.total).toBe(5);
    expect(p1.pageCount).toBe(3);
    expect(p1.items.map((n) => n.id)).toEqual([...ids].reverse().slice(0, 2));
    const p3 = browseNovelsOffset(t.deps, { sort: 'latest' }, 3, 2);
    expect(p3.items.map((n) => n.id)).toEqual([ids[0]!]);
    // 越界收敛到最后一页，不 404。
    expect(browseNovelsOffset(t.deps, { sort: 'latest' }, 99, 2).page).toBe(3);
    // 标签筛选与游标版本共用同一个归一化条件。
    expect(browseNovelsOffset(t.deps, { sort: 'latest', tag: '玄幻' }, 1, 10).total).toBe(2);
    expect(browseNovelsOffset(t.deps, { sort: 'latest', tag: ' 玄幻 ' }, 1, 10).total).toBe(2);
    // 下架的作品两边都看不到。
    await t.json('PATCH', `/api/v1/novels/${ids[0]}`, { token, body: { visibility: 'unpublished' } });
    expect(browseNovelsOffset(t.deps, { sort: 'latest' }, 1, 10).total).toBe(4);
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
