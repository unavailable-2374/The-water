/**
 * §3.2 发布管理：下架（可逆）与版本回滚。
 */
import { describe, expect, it } from 'bun:test';
import { NovelResponseSchema, SetCurrentVersionResponseSchema, VersionListResponseSchema } from '@the-water/shared';
import { createNovel, makeChapters, makeTestApp, manifestOf, publish, sampleStoryline } from './helpers';

describe('§3.2 下架与上架', () => {
  it('可见性能回到 unpublished，数据与谱系都留着，之后还能再上架', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const n = await createNovel(t, a, { title: '灯下长街', license: 'cc-by-sa', allowDerivatives: true });
    const { version } = await publish(t, a, n.id, await makeChapters(3, 1, 200));
    expect((await t.json('GET', '/api/v1/novels')).body.items.length).toBe(1);

    // 别人先派生一本，用来验证下架不会切断谱系。
    const fork = await t.json('POST', `/api/v1/novels/${n.id}/forks`, { token: b, body: {} });
    const deriv = await createNovel(t, b, {
      title: '续写',
      license: 'cc-by-sa',
      allowDerivatives: true,
      source: { forkId: fork.body.fork.id },
    } as never);
    await publish(t, b, deriv.id, await makeChapters(1, 9, 200));

    // 下架。
    const off = await t.json('PATCH', `/api/v1/novels/${n.id}`, { token: a, body: { visibility: 'unpublished' } });
    expect(off.status).toBe(200);
    expect(NovelResponseSchema.parse(off.body).novel.visibility).toBe('unpublished');
    expect((await t.json('GET', '/api/v1/novels')).body.items.map((x: any) => x.id)).toEqual([deriv.id]);
    expect((await t.json('GET', `/api/v1/novels/${n.id}`)).status).toBe(404);
    // 作者自己看得见，版本与当前版本都还在。
    const mine = await t.json('GET', `/api/v1/novels/${n.id}`, { token: a });
    expect(mine.status).toBe(200);
    expect(mine.body.novel.currentVersion.id).toBe(version.id);
    expect(mine.body.novel.chapterCount).toBe(3);
    // 不是软删除：/me/novels 里照样在。
    expect((await t.json('GET', '/api/v1/me/novels', { token: a })).body.items.map((x: any) => x.id)).toContain(n.id);
    // 谱系仍然指得回来（下架的节点显示为占位）。
    const lin = await t.json('GET', `/api/v1/novels/${deriv.id}/lineage`);
    expect(lin.body.ancestors[0].visibility).toBe('unavailable');

    // 再上架。
    const on = await t.json('PATCH', `/api/v1/novels/${n.id}`, { token: a, body: { visibility: 'public' } });
    expect(NovelResponseSchema.parse(on.body).novel.visibility).toBe('public');
    expect((await t.json('GET', '/api/v1/novels')).body.items.map((x: any) => x.id)).toContain(n.id);
    expect((await t.json('GET', `/api/v1/novels/${deriv.id}/lineage`)).body.ancestors[0].visibility).toBe('public');
  });

  it('下架不会改掉作者原本的发布意愿，unlisted 下架再上架仍是 unlisted', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const n = await createNovel(t, token, { title: '仅链接可见', visibility: 'unlisted' });
    await publish(t, token, n.id, await makeChapters(1, 1, 200));
    expect((await t.json('GET', `/api/v1/novels/${n.id}`)).body.novel.visibility).toBe('unlisted');

    await t.json('PATCH', `/api/v1/novels/${n.id}`, { token, body: { visibility: 'unpublished' } });
    // 再发一个版本：提交时按 publishVisibility 恢复，仍然是 unlisted 而不是 public。
    await publish(t, token, n.id, await makeChapters(2, 2, 200));
    expect((await t.json('GET', `/api/v1/novels/${n.id}`)).body.novel.visibility).toBe('unlisted');
  });

  it('还没提交过版本的小说改可见性只记录意愿，不会凭空变成公开', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const n = await createNovel(t, token, { title: '草稿' });
    const r = await t.json('PATCH', `/api/v1/novels/${n.id}`, { token, body: { visibility: 'public' } });
    expect(r.body.novel.visibility).toBe('unpublished');
    expect((await t.json('GET', '/api/v1/novels')).body.items.length).toBe(0);
  });
});

describe('§3.2 版本回滚', () => {
  it('把 vN 设为当前版本，并同步 chapterCount / charCount 等反规范化字段', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const n = await createNovel(t, token, { title: '回滚' });
    const v1 = await publish(t, token, n.id, await makeChapters(2, 1, 200));
    t.clock.advance(1000);
    const v2 = await publish(t, token, n.id, await makeChapters(5, 2, 200));

    const afterV2 = (await t.json('GET', `/api/v1/novels/${n.id}`)).body.novel;
    expect(afterV2.currentVersion.versionNumber).toBe(2);
    expect(afterV2.chapterCount).toBe(5);
    const lastPublishedAt = afterV2.lastPublishedAt;
    const publishedAt = afterV2.publishedAt;

    t.clock.advance(1000);
    const rolled = await t.json('PUT', `/api/v1/novels/${n.id}/current-version`, {
      token,
      body: { versionId: v1.version.id },
    });
    expect(rolled.status).toBe(200);
    const parsed = SetCurrentVersionResponseSchema.parse(rolled.body);
    expect(parsed.version.versionNumber).toBe(1);
    expect(parsed.novel.currentVersion?.id).toBe(v1.version.id);
    expect(parsed.novel.chapterCount).toBe(v1.version.chapterCount);
    expect(parsed.novel.charCount).toBe(v1.version.charCount);
    // 回滚不是发布：发布时间与可见性都不动，作品不会被顶到「最新」列表最前面。
    expect(parsed.novel.lastPublishedAt).toBe(lastPublishedAt);
    expect(parsed.novel.publishedAt).toBe(publishedAt);
    expect(parsed.novel.visibility).toBe('public');
    // 也不记新动态。
    const feed = await t.json('GET', '/api/v1/feed?scope=all&collapse=false');
    expect(feed.body.items.length).toBe(2);

    // 读者看到的是 v1 的内容。
    const chapters = await t.json('GET', `/api/v1/novels/${n.id}/versions/current/chapters`);
    expect(chapters.body.total).toBe(2);

    // v2 还在，能再滚回去。
    const list = VersionListResponseSchema.parse((await t.json('GET', `/api/v1/novels/${n.id}/versions`)).body);
    expect(list.items.map((v) => v.versionNumber)).toEqual([2, 1]);
    const back = await t.json('PUT', `/api/v1/novels/${n.id}/current-version`, { token, body: { versionId: v2.version.id } });
    expect(back.body.novel.chapterCount).toBe(5);
  });

  it('只接受已提交版本，且只有作者能回滚', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const n = await createNovel(t, a, { title: '权限' });
    const v1 = await publish(t, a, n.id, await makeChapters(1, 1, 200));

    expect((await t.json('PUT', `/api/v1/novels/${n.id}/current-version`, { token: a, body: { versionId: 'nope' } })).status).toBe(404);
    expect((await t.json('PUT', `/api/v1/novels/${n.id}/current-version`, { token: b, body: { versionId: v1.version.id } })).status).toBe(403);
    expect((await t.json('PUT', `/api/v1/novels/${n.id}/current-version`, { body: { versionId: v1.version.id } })).status).toBe(401);
  });

  it('未提交的草稿不能被设为当前版本', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const n = await createNovel(t, token, { title: '草稿不能当当前版本' });
    await publish(t, token, n.id, await makeChapters(1, 1, 200));
    const chs = await makeChapters(2, 5, 200);
    const draft = await t.json('POST', `/api/v1/novels/${n.id}/versions`, {
      token,
      headers: { 'Idempotency-Key': 'draft-only' },
      body: { storyline: sampleStoryline(), bible: null, chapters: manifestOf(chs) },
    });
    expect(draft.status).toBe(201);
    const r = await t.json('PUT', `/api/v1/novels/${n.id}/current-version`, {
      token,
      body: { versionId: draft.body.version.id },
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('VERSION_NOT_DRAFT');
  });
});
