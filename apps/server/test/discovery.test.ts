/**
 * §3.4 发现与检索：标签目录、用户搜索、想读书架、云端阅读进度、改名后的旧 @用户名。
 */
import { describe, expect, it } from 'bun:test';
import {
  BookmarkListResponseSchema,
  BookmarkResponseSchema,
  NovelListResponseSchema,
  PopularTagsResponseSchema,
  ReadingProgressListResponseSchema,
  ReadingProgressResponseSchema,
  TagListResponseSchema,
  UserListResponseSchema,
  normalizeTagSlug,
} from '@the-water/shared';
import { createNovel, makeChapters, makeTestApp, publish } from './helpers';

async function publishWith(
  t: ReturnType<typeof makeTestApp>,
  token: string,
  title: string,
  tags: string[],
  seed = 1,
) {
  const n = await createNovel(t, token, { title, tags, license: 'cc-by', allowDerivatives: true });
  await publish(t, token, n.id, await makeChapters(1, seed, 200));
  t.clock.advance(1000);
  return n.id;
}

describe('§3.4 标签目录', () => {
  it('归一化规则与迁移里的 lower(trim(...)) 一致：只降 ASCII 大小写', () => {
    expect(normalizeTagSlug('  言情 ')).toBe('言情');
    expect(normalizeTagSlug('SciFi')).toBe('scifi');
    // SQLite 的 lower() 不动非 ASCII，这里也不能动，否则 slug 与回填的对不上。
    expect(normalizeTagSlug('CAFÉ')).toBe('cafÉ');
  });

  it('计数只算公开可读的作品，下架 / 软删 / 审核隐藏都会实时扣回去', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const { token: admin } = await t.register('admin@example.com');
    const a = await publishWith(t, token, '一', ['玄幻', ' 言情 '], 1);
    const b = await publishWith(t, token, '二', ['玄幻'], 2);
    const c = await publishWith(t, token, '三', ['玄幻'], 3);
    // 未发布的作品有映射但不计数。
    await createNovel(t, token, { title: '草稿', tags: ['玄幻'] });

    const dir = TagListResponseSchema.parse((await t.json('GET', '/api/v1/tags')).body);
    expect(dir.items.map((x) => [x.slug, x.novelCount])).toEqual([
      ['玄幻', 3],
      ['言情', 1],
    ]);
    // 展示名取的是作者写的原始写法（去掉首尾空格）。
    expect(dir.items.find((x) => x.slug === '言情')!.label).toBe('言情');

    await t.json('PATCH', `/api/v1/novels/${a}`, { token, body: { visibility: 'unpublished' } });
    expect(
      TagListResponseSchema.parse((await t.json('GET', '/api/v1/tags')).body).items.map((x) => [x.slug, x.novelCount]),
    ).toEqual([['玄幻', 2]]);

    await t.json('DELETE', `/api/v1/novels/${b}`, { token });
    expect(
      TagListResponseSchema.parse((await t.json('GET', '/api/v1/tags')).body).items.map((x) => [x.slug, x.novelCount]),
    ).toEqual([['玄幻', 1]]);

    // 审核隐藏 / 恢复由 admin 模块改状态（那个文件不归本模块所有，接入片段见交付报告）。
    // 这里直接调用同步函数，验证它对这条路径同样有效。
    await t.json('PATCH', `/api/v1/admin/novels/${c}/moderation`, { token: admin, body: { moderationStatus: 'hidden' } });
    const { syncNovelTags } = await import('../src/modules/novels/tags');
    syncNovelTags(t.deps, t.deps.db, c);
    expect(TagListResponseSchema.parse((await t.json('GET', '/api/v1/tags')).body).items).toEqual([]);

    await t.json('PATCH', `/api/v1/admin/novels/${c}/moderation`, { token: admin, body: { moderationStatus: 'ok' } });
    syncNovelTags(t.deps, t.deps.db, c);
    expect(
      TagListResponseSchema.parse((await t.json('GET', '/api/v1/tags')).body).items.map((x) => [x.slug, x.novelCount]),
    ).toEqual([['玄幻', 1]]);
  });

  it('改标签会同时增删映射并重算两边计数', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const id = await publishWith(t, token, '一', ['玄幻'], 1);
    await publishWith(t, token, '二', ['玄幻'], 2);

    await t.json('PATCH', `/api/v1/novels/${id}`, { token, body: { tags: ['武侠'] } });
    const dir = TagListResponseSchema.parse((await t.json('GET', '/api/v1/tags')).body);
    expect(Object.fromEntries(dir.items.map((x) => [x.slug, x.novelCount]))).toEqual({ 玄幻: 1, 武侠: 1 });

    // 计数归零的标签不留在目录里。
    await t.json('PATCH', `/api/v1/novels/${id}`, { token, body: { tags: [] } });
    expect(
      TagListResponseSchema.parse((await t.json('GET', '/api/v1/tags')).body).items.map((x) => x.slug),
    ).toEqual(['玄幻']);
  });

  it('目录支持按名字排序、模糊匹配与游标翻页，热门标签单独一个端点', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    await publishWith(t, token, '一', ['aa', 'ab', 'ba'], 1);
    await publishWith(t, token, '二', ['aa', 'ab'], 2);
    await publishWith(t, token, '三', ['aa'], 3);

    const byName = TagListResponseSchema.parse((await t.json('GET', '/api/v1/tags?sort=name&limit=2')).body);
    expect(byName.items.map((x) => x.slug)).toEqual(['aa', 'ab']);
    const page2 = TagListResponseSchema.parse(
      (await t.json('GET', `/api/v1/tags?sort=name&limit=2&cursor=${encodeURIComponent(byName.nextCursor!)}`)).body,
    );
    expect(page2.items.map((x) => x.slug)).toEqual(['ba']);
    expect(page2.nextCursor).toBeNull();

    const matched = TagListResponseSchema.parse((await t.json('GET', '/api/v1/tags?q=AB')).body);
    expect(matched.items.map((x) => x.slug)).toEqual(['ab']);

    const hot = PopularTagsResponseSchema.parse((await t.json('GET', '/api/v1/tags/popular?limit=2')).body);
    expect(hot.items.map((x) => [x.slug, x.novelCount])).toEqual([
      ['aa', 3],
      ['ab', 2],
    ]);
  });

  it('浏览按标签过滤走归一化后的映射，大小写与空格不再是两个标签', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    await publishWith(t, token, '一', [' SciFi '], 1);
    const list = NovelListResponseSchema.parse((await t.json('GET', '/api/v1/novels?tag=scifi')).body);
    expect(list.items.map((n) => n.title)).toEqual(['一']);
    expect(
      NovelListResponseSchema.parse((await t.json('GET', '/api/v1/novels?tag=SCIFI')).body).items.length,
    ).toBe(1);
  });
});

describe('§3.4 用户搜索', () => {
  it('匹配 @用户名与昵称，前缀命中排在前面，游标翻页不重不漏', async () => {
    const t = makeTestApp();
    await t.json('POST', '/api/v1/auth/register', {
      body: { email: 'lin@example.com', password: 'password123', displayName: '林晚', handle: 'linwan' },
    });
    await t.json('POST', '/api/v1/auth/register', {
      body: { email: 'lina@example.com', password: 'password123', displayName: '别人', handle: 'linabc' },
    });
    await t.json('POST', '/api/v1/auth/register', {
      body: { email: 'other@example.com', password: 'password123', displayName: '带 lin 的昵称', handle: 'zzz_user' },
    });

    const all = UserListResponseSchema.parse((await t.json('GET', '/api/v1/users?q=lin')).body);
    expect(all.items.map((u) => u.handle)).toEqual(['linabc', 'linwan', 'zzz_user']);

    const first = UserListResponseSchema.parse((await t.json('GET', '/api/v1/users?q=lin&limit=2')).body);
    expect(first.items.map((u) => u.handle)).toEqual(['linabc', 'linwan']);
    const rest = UserListResponseSchema.parse(
      (await t.json('GET', `/api/v1/users?q=lin&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`)).body,
    );
    expect(rest.items.map((u) => u.handle)).toEqual(['zzz_user']);
    expect(rest.nextCursor).toBeNull();

    // 昵称也能搜到。
    expect(UserListResponseSchema.parse((await t.json('GET', '/api/v1/users?q=林晚')).body).items.length).toBe(1);
    // LIKE 通配符不生效（被剥掉了），不会一搜就返回全部。
    expect(UserListResponseSchema.parse((await t.json('GET', '/api/v1/users?q=%25')).body).items.length).toBe(0);
    expect((await t.json('GET', '/api/v1/users?q=')).status).toBe(400);
  });

  it('互相屏蔽的人不出现在搜索结果里', async () => {
    const t = makeTestApp();
    const { token: a, user: au } = await t.register('aaa@example.com', '甲');
    const { user: bu } = await t.register('bbb@example.com', '乙');
    await t.json('PUT', `/api/v1/users/${bu.id}/block`, { token: a });

    const handles = (raw: any) => UserListResponseSchema.parse(raw).items.map((u) => u.id);
    expect(handles((await t.json('GET', '/api/v1/users?q=u_', { token: a })).body)).toEqual([au.id]);
    expect(handles((await t.json('GET', '/api/v1/users?q=u_')).body).sort()).toEqual([au.id, bu.id].sort());
  });
});

describe('§3.4 改名后的旧 @用户名', () => {
  it('改名后旧用户名仍能查到人，响应里带的是新用户名', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const before = (await t.json('GET', '/api/v1/auth/me', { token })).body.user.handle;
    await t.json('PATCH', '/api/v1/auth/me', { token, body: { handle: 'newname' } });

    // 直接调用服务层的登记函数（auth/service.ts 的接入片段见交付报告）。
    const { recordHandleChange } = await import('../src/modules/users/service');
    const me = (await t.json('GET', '/api/v1/auth/me', { token })).body.user;
    recordHandleChange(t.deps, me.id, before, 'newname');

    const old = await t.json('GET', `/api/v1/users/by-handle/${before}`);
    expect(old.status).toBe(200);
    expect(old.body.user.handle).toBe('newname');
    expect((await t.json('GET', '/api/v1/users/by-handle/newname')).status).toBe(200);
    expect((await t.json('GET', '/api/v1/users/by-handle/nobody_here')).status).toBe(404);
  });
});

describe('§3.4 想读书架', () => {
  it('与「喜欢」相互独立，重复添加幂等，取消后消失', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const id = await publishWith(t, a, '灯下长街', ['言情'], 1);

    expect(BookmarkResponseSchema.parse((await t.json('GET', `/api/v1/novels/${id}/bookmark`, { token: b })).body).bookmarked).toBe(false);
    expect(BookmarkResponseSchema.parse((await t.json('PUT', `/api/v1/novels/${id}/bookmark`, { token: b })).body).bookmarked).toBe(true);
    expect(BookmarkResponseSchema.parse((await t.json('GET', `/api/v1/novels/${id}/bookmark`, { token: b })).body).bookmarked).toBe(true);
    // 幂等。
    await t.json('PUT', `/api/v1/novels/${id}/bookmark`, { token: b });
    const shelf = BookmarkListResponseSchema.parse((await t.json('GET', '/api/v1/me/bookmarks', { token: b })).body);
    expect(shelf.items.map((n) => n.id)).toEqual([id]);
    // 想读不等于喜欢。
    expect((await t.json('GET', '/api/v1/me/likes', { token: b })).body.items).toEqual([]);
    expect((await t.json('GET', `/api/v1/novels/${id}`, { token: b })).body.novel.likeCount).toBe(0);

    await t.json('DELETE', `/api/v1/novels/${id}/bookmark`, { token: b });
    expect((await t.json('GET', '/api/v1/me/bookmarks', { token: b })).body.items).toEqual([]);
    expect((await t.json('GET', '/api/v1/me/bookmarks')).status).toBe(401);
  });

  it('先过滤后切页：下架的书直接不占页，也不会留下空的 nextCursor', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await publishWith(t, a, `第 ${i} 本`, ['言情'], i + 1));
    for (const id of ids) {
      await t.json('PUT', `/api/v1/novels/${id}/bookmark`, { token: b });
      t.clock.advance(1000);
    }
    await t.json('PATCH', `/api/v1/novels/${ids[1]}`, { token: a, body: { visibility: 'unpublished' } });

    const first = BookmarkListResponseSchema.parse(
      (await t.json('GET', '/api/v1/me/bookmarks?limit=2', { token: b })).body,
    );
    expect(first.items.length).toBe(2);
    expect(first.nextCursor).toBeNull();
    // 书架条目还在，作者重新上架后又会出现。
    await t.json('PATCH', `/api/v1/novels/${ids[1]}`, { token: a, body: { visibility: 'public' } });
    expect(
      BookmarkListResponseSchema.parse((await t.json('GET', '/api/v1/me/bookmarks', { token: b })).body).items.length,
    ).toBe(3);
  });
});

describe('§3.4 云端阅读进度', () => {
  it('上报后可跨设备读回，同一本书只留最新一条', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const id = await publishWith(t, a, '灯下长街', ['言情'], 1);

    expect(
      ReadingProgressResponseSchema.parse((await t.json('GET', `/api/v1/novels/${id}/progress`, { token: b })).body).progress,
    ).toBeNull();

    await t.json('PUT', `/api/v1/novels/${id}/progress`, { token: b, body: { chapterIndex: 0, percent: 30 } });
    t.clock.advance(1000);
    const saved = ReadingProgressResponseSchema.parse(
      (await t.json('PUT', `/api/v1/novels/${id}/progress`, { token: b, body: { chapterIndex: 2, percent: 80 } })).body,
    );
    expect(saved.progress).toMatchObject({ novelId: id, chapterIndex: 2, percent: 80 });

    const read = ReadingProgressResponseSchema.parse(
      (await t.json('GET', `/api/v1/novels/${id}/progress`, { token: b })).body,
    );
    expect(read.progress).toMatchObject({ chapterIndex: 2, percent: 80 });
    // 别人的进度互不干扰。
    expect(
      ReadingProgressResponseSchema.parse((await t.json('GET', `/api/v1/novels/${id}/progress`, { token: a })).body).progress,
    ).toBeNull();
    expect((await t.json('GET', `/api/v1/novels/${id}/progress`)).status).toBe(401);
    expect((await t.json('PUT', `/api/v1/novels/${id}/progress`, { token: b, body: { chapterIndex: -1 } })).status).toBe(400);
  });

  it('「在读」列表按最近阅读排序，只列仍可读的作品', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const one = await publishWith(t, a, '一', ['言情'], 1);
    const two = await publishWith(t, a, '二', ['言情'], 2);

    await t.json('PUT', `/api/v1/novels/${one}/progress`, { token: b, body: { chapterIndex: 0, percent: 10 } });
    t.clock.advance(1000);
    await t.json('PUT', `/api/v1/novels/${two}/progress`, { token: b, body: { chapterIndex: 0, percent: 50 } });

    const page = ReadingProgressListResponseSchema.parse((await t.json('GET', '/api/v1/me/progress', { token: b })).body);
    expect(page.items.map((x) => x.novel.id)).toEqual([two, one]);
    expect(page.items[0]!.progress.percent).toBe(50);

    await t.json('DELETE', `/api/v1/novels/${two}`, { token: a });
    expect(
      ReadingProgressListResponseSchema.parse((await t.json('GET', '/api/v1/me/progress', { token: b })).body).items.map(
        (x) => x.novel.id,
      ),
    ).toEqual([one]);
  });
});
