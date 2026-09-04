import { describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { LineageResponseSchema, MyStorageResponseSchema, VersionListResponseSchema, utf8ByteLength } from '@the-water/shared';
import { blobs, novels, novelVersions } from '../src/db/schema';
import { DAY, HOUR } from '../src/lib/time';
import { buildLineage, MAX_DESCENDANTS } from '../src/modules/forks/lineage';
import { gcBlobs, gcDrafts } from '../src/modules/versions/service';
import { createNovel, expectSchema, makeChapters, makeTestApp, manifestOf, publish, sampleStoryline, type Chapter } from './helpers';

const blobHashes = (t: ReturnType<typeof makeTestApp>) =>
  t.deps.db
    .select({ hash: blobs.hash })
    .from(blobs)
    .all()
    .map((r) => r.hash)
    .sort();

async function uploadAll(t: ReturnType<typeof makeTestApp>, token: string, chs: Chapter[]) {
  return t.json('POST', '/api/v1/blobs', { token, body: { blobs: chs.map((c) => ({ hash: c.hash, content: c.content })) } });
}

/** 建草稿但不提交，并把 blob 传上去（模拟"发布到一半"）。 */
async function stageDraft(t: ReturnType<typeof makeTestApp>, token: string, novelId: string, chs: Chapter[], key: string) {
  const draft = await t.json('POST', `/api/v1/novels/${novelId}/versions`, {
    token,
    headers: { 'Idempotency-Key': key },
    body: { storyline: sampleStoryline(), bible: null, chapters: manifestOf(chs) },
  });
  expect(draft.status).toBe(201);
  expect((await uploadAll(t, token, chs)).status).toBe(200);
  return draft.body.version.id as string;
}

describe('gcBlobs：孤儿 blob 回收', () => {
  it('宽限期内的孤儿不回收，过了宽限期才回收', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const chs = await makeChapters(2, 11);
    expect((await uploadAll(t, token, chs)).status).toBe(200);
    expect(blobHashes(t).length).toBe(2);

    // 刚上传：还没来得及建草稿，绝不能删。
    expect(gcBlobs(t.deps)).toBe(0);
    t.clock.advance(HOUR);
    expect(gcBlobs(t.deps)).toBe(0);
    expect(blobHashes(t).length).toBe(2);

    t.clock.advance(DAY);
    expect(gcBlobs(t.deps)).toBe(2);
    expect(blobHashes(t).length).toBe(0);
  });

  it('未过期草稿的 manifest 引用算引用，不会误删正在上传的内容', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const novel = await createNovel(t, token);
    const chs = await makeChapters(3, 22);
    await stageDraft(t, token, novel.id, chs, 'd1');
    expect(blobHashes(t).length).toBe(3);

    // 草稿只有 1 小时大，未过期；把宽限期调小让 blob 成为候选，仍不该删。
    t.clock.advance(HOUR);
    expect(gcBlobs(t.deps, HOUR / 2)).toBe(0);
    expect(blobHashes(t).length).toBe(3);

    // 草稿过期后引用消失，孤儿才被回收。
    t.clock.advance(DAY);
    expect(gcBlobs(t.deps)).toBe(3);
    expect(blobHashes(t).length).toBe(0);
  });

  it('已提交版本引用的 blob 永不回收', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const novel = await createNovel(t, token);
    const chs = await makeChapters(2, 33);
    await publish(t, token, novel.id, chs);
    const kept = blobHashes(t);
    expect(kept.length).toBe(2);

    t.clock.advance(DAY * 30);
    expect(gcBlobs(t.deps)).toBe(0);
    expect(blobHashes(t)).toEqual(kept);
  });

  it('失败 / 中止的发布留下的 blob 会被回收，已提交的同批内容不受牵连', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const novel = await createNovel(t, token);
    const published = await makeChapters(2, 44);
    await publish(t, token, novel.id, published);

    // 另一个草稿：传了 blob 但被中止，等价于"发布失败"。
    const abandoned = await makeChapters(2, 55);
    const draftId = await stageDraft(t, token, novel.id, abandoned, 'd-abort');
    expect((await t.json('DELETE', `/api/v1/novels/${novel.id}/versions/${draftId}`, { token })).status).toBe(200);
    expect(blobHashes(t).length).toBe(4);

    t.clock.advance(DAY + 1000);
    expect(gcDrafts(t.deps)).toBe(1);
    expect(gcBlobs(t.deps)).toBe(2);
    expect(blobHashes(t)).toEqual(published.map((c) => c.hash).sort());
  });

  it('中止的草稿即使还没被 gcDrafts 清掉，也不再算作引用', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const novel = await createNovel(t, token);
    const chs = await makeChapters(2, 66);
    const draftId = await stageDraft(t, token, novel.id, chs, 'd-x');
    await t.json('DELETE', `/api/v1/novels/${novel.id}/versions/${draftId}`, { token });
    expect(t.deps.db.select().from(novelVersions).where(eq(novelVersions.id, draftId)).get()?.status).toBe('aborted');

    t.clock.advance(HOUR);
    expect(gcBlobs(t.deps, HOUR / 2)).toBe(2);
    expect(blobHashes(t).length).toBe(0);
  });
});

describe('每用户存储配额', () => {
  it('超出配额时整批拒绝，错误里带已用 / 上限', async () => {
    const t = makeTestApp({ env: { storageQuotaBytes: 4000 } });
    const { token } = await t.register('a@example.com');
    const first = await makeChapters(1, 77, 600);
    const bytes = utf8ByteLength(first[0]!.content);
    expect(bytes).toBeLessThan(4000);

    expect((await uploadAll(t, token, first)).status).toBe(200);
    const used = await t.json('GET', '/api/v1/me/storage', { token });
    expect(used.body.usedBytes).toBe(bytes);

    // 再传两章必然越界。
    const more = await makeChapters(2, 88, 600);
    const r = await uploadAll(t, token, more);
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('STORAGE_QUOTA_EXCEEDED');
    expect(r.body.error.message).toContain(String(bytes));
    expect(r.body.error.message).toContain('4000');
    expect(r.body.error.details.quotaBytes).toBe(4000);
    // 拒绝是整批的：一个字节都没写进去。
    expect(blobHashes(t).length).toBe(1);
  });

  it('重复上传已入库的内容不占新配额', async () => {
    const t = makeTestApp({ env: { storageQuotaBytes: 4000 } });
    const { token } = await t.register('a@example.com');
    const chs = await makeChapters(1, 99, 600);
    expect((await uploadAll(t, token, chs)).status).toBe(200);
    // 同样的内容再传 5 次都不该被配额拦下。
    for (let i = 0; i < 5; i++) expect((await uploadAll(t, token, chs)).status).toBe(200);
    expect(blobHashes(t).length).toBe(1);
  });

  it('storageQuotaBytes = 0 表示不限制', async () => {
    const t = makeTestApp({ env: { storageQuotaBytes: 0 } });
    const { token } = await t.register('a@example.com');
    const chs = await makeChapters(6, 111, 800);
    expect((await uploadAll(t, token, chs)).status).toBe(200);
    const r = await t.json('GET', '/api/v1/me/storage', { token });
    expect(r.body.quotaBytes).toBe(0);
    expect(r.body.blobCount).toBe(6);
  });

  it('GET /me/storage 需要登录，且只统计自己上传的内容', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    expect((await t.json('GET', '/api/v1/me/storage')).status).toBe(401);

    const chs = await makeChapters(2, 121);
    await uploadAll(t, a, chs);
    // 内容寻址去重：b 传同样的内容不会重复计费给 b。
    await uploadAll(t, b, chs);

    const ra = expectSchema(MyStorageResponseSchema, (await t.json('GET', '/api/v1/me/storage', { token: a })).body);
    const rb = expectSchema(MyStorageResponseSchema, (await t.json('GET', '/api/v1/me/storage', { token: b })).body);
    expect(ra.blobCount).toBe(2);
    expect(ra.usedBytes).toBe(chs.reduce((s, c) => s + utf8ByteLength(c.content), 0));
    expect(ra.quotaBytes).toBe(200 * 1024 * 1024);
    expect(rb).toEqual({ usedBytes: 0, quotaBytes: ra.quotaBytes, blobCount: 0 });
  });
});

describe('listVersions 游标分页', () => {
  it('按 limit 切页，游标可翻到底且不重不漏', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const novel = await createNovel(t, token);
    for (let i = 0; i < 3; i++) await publish(t, token, novel.id, await makeChapters(2, 200 + i));
    // 再挂两个草稿（versionNumber 都是 0），作者可见。
    for (const key of ['g1', 'g2']) await stageDraft(t, token, novel.id, await makeChapters(1, 300 + key.length), key);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const qs: string = `limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await t.json('GET', `/api/v1/novels/${novel.id}/versions?${qs}`, { token });
      const page = expectSchema(VersionListResponseSchema, res.body);
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((v: { id: string }) => v.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(5);
    // 版本号倒序：已提交的 3、2、1 在前，草稿（0）在后。
    const all = await t.json('GET', `/api/v1/novels/${novel.id}/versions?limit=50`, { token });
    expect(all.body.items.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([3, 2, 1, 0, 0]);
    expect(all.body.nextCursor).toBeNull();
    expect(seen).toEqual(all.body.items.map((v: { id: string }) => v.id));
  });

  it('匿名访客只看到已提交版本', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const novel = await createNovel(t, token);
    await publish(t, token, novel.id, await makeChapters(2, 400));
    await stageDraft(t, token, novel.id, await makeChapters(1, 401), 'anon-draft');

    const r = await t.json('GET', `/api/v1/novels/${novel.id}/versions`);
    const page = expectSchema(VersionListResponseSchema, r.body);
    expect(page.items.map((v) => v.status)).toEqual(['committed']);
    expect(page.nextCursor).toBeNull();
  });

  it('游标非法时返回 400', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const novel = await createNovel(t, token);
    await publish(t, token, novel.id, await makeChapters(1, 500));
    const r = await t.json('GET', `/api/v1/novels/${novel.id}/versions?cursor=%21%21%21`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('lineage 后代查询', () => {
  it('未超限时不置截断标记，子节点按创建时间升序', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const novel = await createNovel(t, token);
    await publish(t, token, novel.id, await makeChapters(1, 600));

    const r = await t.json('GET', `/api/v1/novels/${novel.id}/lineage`);
    const lineage = expectSchema(LineageResponseSchema, r.body);
    expect(lineage.descendantsTruncated).toBe(false);
    expect(lineage.descendants).toEqual([]);
  });

  it('后代超过上限时截断是确定的，并在响应里标记', async () => {
    const t = makeTestApp();
    const { token, user } = await t.register('a@example.com');
    const root = await createNovel(t, token);
    await publish(t, token, root.id, await makeChapters(1, 700));

    // 直接落库造 MAX_DESCENDANTS + 10 个直接派生，避免走一遍完整 fork 流程。
    const base = t.deps.clock.now().getTime();
    const rows = Array.from({ length: MAX_DESCENDANTS + 10 }, (_, i) => ({
      id: `deriv-${String(i).padStart(4, '0')}`,
      authorId: user.id,
      title: `派生 ${i}`,
      license: 'cc-by-sa' as const,
      visibility: 'public' as const,
      sourceNovelId: root.id,
      rootNovelId: root.id,
      depth: 1,
      publishedAt: new Date(base + i * 1000),
      lastPublishedAt: new Date(base + i * 1000),
      createdAt: new Date(base + i * 1000),
      updatedAt: new Date(base + i * 1000),
    }));
    for (let i = 0; i < rows.length; i += 100) t.deps.db.insert(novels).values(rows.slice(i, i + 100)).run();

    const first = buildLineage(t.deps, root.id, null);
    expect(first.descendantsTruncated).toBe(true);
    // 根节点自己占掉一个名额，因此后代少一个。
    expect(first.descendants.length).toBe(MAX_DESCENDANTS - 1);
    // 截断是确定的：保留最早创建的一批，重复调用结果完全一致。
    const second = buildLineage(t.deps, root.id, null);
    expect(second.descendants.map((d) => d.novel.id)).toEqual(first.descendants.map((d) => d.novel.id));
    expect(first.descendants[0]!.novel.id).toBe('deriv-0000');
    expect(first.descendants.some((d) => d.novel.id === `deriv-${String(MAX_DESCENDANTS + 5).padStart(4, '0')}`)).toBe(false);
  });
});
