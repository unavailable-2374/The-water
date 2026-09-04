import { describe, expect, it } from 'bun:test';
import { ForkListResponseSchema, ForkResponseSchema, LineageResponseSchema, NovelBundleV1Schema, hashChapterContent } from '@the-water/shared';
import { blobs } from '../src/db/schema';
import { createNovel, makeChapters, makeTestApp, publish, type Chapter } from './helpers';

describe('fork & lineage', () => {
  it('fork → bundle → derivative publish reusing blobs → lineage both directions', async () => {
    const t = makeTestApp();
    const { token: author } = await t.register('author@example.com', '原作者');
    const { token: remixer, user: remixUser } = await t.register('remix@example.com', '二创者');
    const original = await createNovel(t, author, { title: '原作', license: 'cc-by' });
    const chs = await makeChapters(100, 11, 300);
    const v1 = await publish(t, author, original.id, chs);
    expect(t.deps.db.select().from(blobs).all().length).toBe(100);

    // fork（默认当前版本）
    const f = await t.json('POST', `/api/v1/novels/${original.id}/forks`, { token: remixer, body: {} });
    expect(f.status).toBe(201);
    const { fork } = ForkResponseSchema.parse(f.body);
    expect(fork.sourceVersionId).toBe(v1.version.id);
    expect(fork.sourceVersionNumber).toBe(1);
    expect(fork.derivativeNovelId).toBeNull();
    expect(fork.source.title).toBe('原作');
    expect((await t.json('GET', `/api/v1/novels/${original.id}`)).body.novel.forkCount).toBe(1);
    expect((await t.json('GET', `/api/v1/novels/${original.id}`, { token: remixer })).body.novel.viewer).toMatchObject({ liked: false, forked: true });

    // bundle
    const b = await t.json('GET', `/api/v1/novels/${original.id}/versions/current/bundle?forkId=${fork.id}`, { token: remixer });
    expect(b.status).toBe(200);
    const bundle = NovelBundleV1Schema.parse(b.body);
    expect(bundle.fork?.id).toBe(fork.id);
    expect(bundle.chapters.length).toBe(100);
    expect(bundle.lineage).toEqual({ sourceNovelId: null, sourceVersionId: null, rootNovelId: original.id, depth: 0 });
    for (const ch of bundle.chapters) expect(await hashChapterContent(ch.content)).toBe(ch.hash);
    // 别人的 forkId 不可用；匿名可拉公开 bundle（无 fork）
    expect((await t.json('GET', `/api/v1/novels/${original.id}/versions/current/bundle?forkId=${fork.id}`, { token: author })).status).toBe(404);
    expect((await t.json('GET', `/api/v1/novels/${original.id}/versions/current/bundle`)).body.fork).toBeNull();

    // 二创：改写 20 章，其余 80 章复用 blob
    const derivChs: Chapter[] = [...chs];
    for (let i = 0; i < 20; i++) {
      const content = `改写版：\n\n${chs[i]!.content}`;
      derivChs[i] = { ...chs[i]!, content, hash: await hashChapterContent(content), charCount: chs[i]!.charCount + 4 };
    }
    const deriv = await createNovel(t, remixer, { title: '二创', license: 'cc-by', source: { forkId: fork.id } });
    expect(deriv.source?.novel.id).toBe(original.id);
    expect(deriv.source?.versionNumber).toBe(1);
    expect(deriv.rootNovelId).toBe(original.id);
    expect(deriv.depth).toBe(1);
    expect(deriv.isDerivative).toBe(true);
    const pub = await publish(t, remixer, deriv.id, derivChs);
    expect(pub.uploaded).toBe(20);
    expect(t.deps.db.select().from(blobs).all().length).toBe(120);

    // fork 记录已绑定，只能发布一本
    const forks = await t.json('GET', '/api/v1/me/forks', { token: remixer });
    const fl = ForkListResponseSchema.parse(forks.body);
    expect(fl.items[0]!.derivativeNovelId).toBe(deriv.id);
    expect(fl.items[0]!.derivative?.title).toBe('二创');
    const again = await t.json('POST', '/api/v1/novels', { token: remixer, body: { title: '第二本', license: 'cc-by', allowDerivatives: true, source: { forkId: fork.id } } });
    expect(again.status).toBe(409);
    // 别人不能用我的 fork
    expect((await t.json('POST', '/api/v1/novels', { token: author, body: { title: 'x', license: 'cc-by', allowDerivatives: true, source: { forkId: fork.id } } })).status).toBe(404);

    // 三代
    const { token: third } = await t.register('third@example.com', '三创者');
    const f2 = await t.json('POST', `/api/v1/novels/${deriv.id}/forks`, { token: third, body: {} });
    const gen3 = await createNovel(t, third, { title: '三创', license: 'cc-by', source: { forkId: f2.body.fork.id } });
    await publish(t, third, gen3.id, derivChs.slice(0, 5));
    expect(gen3.depth).toBe(2);
    expect(gen3.rootNovelId).toBe(original.id);

    // 谱系：从中间节点看
    const lin = await t.json('GET', `/api/v1/novels/${deriv.id}/lineage`);
    expect(lin.status).toBe(200);
    const L = LineageResponseSchema.parse(lin.body);
    expect(L.root.id).toBe(original.id);
    expect(L.ancestors.map((a) => a.id)).toEqual([original.id]);
    expect(L.self.id).toBe(deriv.id);
    expect(L.descendants.length).toBe(1);
    expect(L.descendants[0]!.novel.id).toBe(gen3.id);
    expect(L.descendants[0]!.sourceVersionNumber).toBe(1);
    // 从根看
    const rootLin = LineageResponseSchema.parse((await t.json('GET', `/api/v1/novels/${original.id}/lineage`)).body);
    expect(rootLin.ancestors).toEqual([]);
    expect(rootLin.descendants[0]!.novel.id).toBe(deriv.id);
    expect(rootLin.descendants[0]!.children[0]!.novel.id).toBe(gen3.id);
    // 从叶看
    const leafLin = LineageResponseSchema.parse((await t.json('GET', `/api/v1/novels/${gen3.id}/lineage`)).body);
    expect(leafLin.ancestors.map((a) => a.id)).toEqual([original.id, deriv.id]);
    expect(leafLin.descendants).toEqual([]);

    // 中间节点下架 → 占位“（已下架）”，结构保留
    await t.json('DELETE', `/api/v1/novels/${deriv.id}`, { token: remixer });
    const afterDel = LineageResponseSchema.parse((await t.json('GET', `/api/v1/novels/${gen3.id}/lineage`)).body);
    expect(afterDel.ancestors[1]).toEqual({ id: deriv.id, title: '（已下架）', authorDisplayName: '', visibility: 'unavailable' });
    expect(afterDel.root.id).toBe(original.id);
    const gen3Detail = await t.json('GET', `/api/v1/novels/${gen3.id}`);
    expect(gen3Detail.body.novel.source.novel.visibility).toBe('unavailable');
    void remixUser;
  });

  it('SA licenses are inherited: derivative must use the same license', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const src = await createNovel(t, a, { license: 'cc-by-nc-sa', allowDerivatives: true });
    await publish(t, a, src.id, await makeChapters(2));
    const f = await t.json('POST', `/api/v1/novels/${src.id}/forks`, { token: b, body: {} });
    const bad = await t.json('POST', '/api/v1/novels', { token: b, body: { title: 'x', license: 'cc-by', allowDerivatives: true, source: { forkId: f.body.fork.id } } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.requiredLicense).toBe('cc-by-nc-sa');
    const good = await t.json('POST', '/api/v1/novels', { token: b, body: { title: 'x', license: 'cc-by-nc-sa', allowDerivatives: true, source: { forkId: f.body.fork.id } } });
    expect(good.status).toBe(201);
    // 之后也不能改成别的许可
    const patch = await t.json('PATCH', `/api/v1/novels/${good.body.novel.id}`, { token: b, body: { license: 'cc0' } });
    expect(patch.status).toBe(400);
  });

  it('all-rights-reserved / allowDerivatives=false refuse forks; existing fork survives later closure', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const arr = await createNovel(t, a, { license: 'all-rights-reserved', allowDerivatives: true });
    await publish(t, a, arr.id, await makeChapters(1));
    const r = await t.json('POST', `/api/v1/novels/${arr.id}/forks`, { token: b, body: {} });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('DERIVATIVES_NOT_ALLOWED');
    expect((await t.json('POST', `/api/v1/novels/${arr.id}/forks`, { body: {} })).status).toBe(401);

    const open = await createNovel(t, a, { license: 'cc-by', allowDerivatives: true });
    await publish(t, a, open.id, await makeChapters(1));
    const f = await t.json('POST', `/api/v1/novels/${open.id}/forks`, { token: b, body: {} });
    expect(f.status).toBe(201);
    await t.json('PATCH', `/api/v1/novels/${open.id}`, { token: a, body: { allowDerivatives: false } });
    expect((await t.json('POST', `/api/v1/novels/${open.id}/forks`, { token: b, body: {} })).status).toBe(403);
    // 已有 fork 仍可拉 bundle 并发布二创
    expect((await t.json('GET', `/api/v1/novels/${open.id}/versions/current/bundle?forkId=${f.body.fork.id}`, { token: b })).status).toBe(200);
    const d = await t.json('POST', '/api/v1/novels', { token: b, body: { title: 'd', license: 'cc-by', allowDerivatives: true, source: { forkId: f.body.fork.id } } });
    expect(d.status).toBe(201);
  });

  it('fork 限流：超出 fork 规则返回 429', async () => {
    const t = makeTestApp({ rateLimits: { fork: { max: 1, windowMs: 60 * 60_000 } } });
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const n1 = await createNovel(t, a, { title: '一', license: 'cc-by' });
    await publish(t, a, n1.id, await makeChapters(1));
    const n2 = await createNovel(t, a, { title: '二', license: 'cc-by' });
    await publish(t, a, n2.id, await makeChapters(1, 3));

    expect((await t.json('POST', `/api/v1/novels/${n1.id}/forks`, { token: b, body: {} })).status).toBe(201);
    const limited = await t.json('POST', `/api/v1/novels/${n2.id}/forks`, { token: b, body: {} });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  it('fork pins a specific committed version; unpublished/unknown versions rejected', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const n = await createNovel(t, a, { license: 'cc0' });
    const v1 = await publish(t, a, n.id, await makeChapters(2, 1));
    const v2 = await publish(t, a, n.id, await makeChapters(3, 2));
    const f = await t.json('POST', `/api/v1/novels/${n.id}/forks`, { token: b, body: { versionId: v1.version.id } });
    expect(f.status).toBe(201);
    expect(f.body.fork.sourceVersionNumber).toBe(1);
    const bundle = await t.json('GET', `/api/v1/novels/${n.id}/versions/current/bundle?forkId=${f.body.fork.id}`, { token: b });
    expect(bundle.body.version.id).toBe(v1.version.id);
    expect(bundle.body.chapters.length).toBe(2);
    expect((await t.json('GET', `/api/v1/novels/${n.id}/versions/${v2.version.id}/bundle`)).body.chapters.length).toBe(3);
    // §3.3：同一用户对同一原作重复 fork 是幂等的，返回既有记录，forkCount 不变。
    const again = await t.json('POST', `/api/v1/novels/${n.id}/forks`, { token: b, body: { versionId: v2.version.id } });
    expect(again.status).toBe(201);
    expect(again.body.fork.id).toBe(f.body.fork.id);
    expect(again.body.fork.sourceVersionId).toBe(v1.version.id);
    expect((await t.json('GET', `/api/v1/novels/${n.id}`)).body.novel.forkCount).toBe(1);
    // 未知版本仍然 404（换一个还没 fork 过的人）。
    const { token: c } = await t.register('c@example.com');
    expect((await t.json('POST', `/api/v1/novels/${n.id}/forks`, { token: c, body: { versionId: 'nope' } })).status).toBe(404);
    const unpub = await createNovel(t, a, { license: 'cc0' });
    expect((await t.json('POST', `/api/v1/novels/${unpub.id}/forks`, { token: b, body: {} })).status).toBe(404);
  });
});
