import { describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  CommitVersionResponseSchema,
  CreateVersionResponseSchema,
  NovelResponseSchema,
  UploadBlobsResponseSchema,
  VersionStatusResponseSchema,
  hashChapterContent,
} from '@the-water/shared';
import { blobs, novelVersions } from '../src/db/schema';
import { DAY } from '../src/lib/time';
import { gcDrafts } from '../src/modules/versions/service';
import { createNovel, expectSchema, makeChapters, makeTestApp, manifestOf, publish, sampleStoryline } from './helpers';

const draftBody = (chs: Awaited<ReturnType<typeof makeChapters>>) => ({
  storyline: sampleStoryline(),
  bible: null,
  chapters: manifestOf(chs),
});

describe('publish protocol', () => {
  it('creates a novel (unpublished until first commit) and lists it under /me/novels', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const r = await t.json('POST', '/api/v1/novels', {
      token,
      body: { title: '灯下长街', license: 'cc-by-sa', allowDerivatives: true, tags: ['言情'] },
    });
    expect(r.status).toBe(201);
    const { novel } = expectSchema(NovelResponseSchema, r.body);
    expect(novel.visibility).toBe('unpublished');
    expect(novel.currentVersion).toBeNull();
    expect(novel.rootNovelId).toBe(novel.id);
    // 匿名不可见，作者可见
    expect((await t.json('GET', `/api/v1/novels/${novel.id}`)).status).toBe(404);
    expect((await t.json('GET', `/api/v1/novels/${novel.id}`, { token })).status).toBe(200);
    const mine = await t.json('GET', '/api/v1/me/novels', { token });
    expect(mine.body.items.map((n: any) => n.id)).toEqual([novel.id]);
  });

  it('all-rights-reserved forces allowDerivatives=false', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const n = await createNovel(t, token, { license: 'all-rights-reserved', allowDerivatives: true });
    expect(n.allowDerivatives).toBe(false);
    const p = await t.json('PATCH', `/api/v1/novels/${n.id}`, { token, body: { allowDerivatives: true } });
    expect(p.body.novel.allowDerivatives).toBe(false);
    const p2 = await t.json('PATCH', `/api/v1/novels/${n.id}`, { token, body: { license: 'cc-by', allowDerivatives: true } });
    expect(p2.body.novel.allowDerivatives).toBe(true);
  });

  it('100-chapter end-to-end publish', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const novel = await createNovel(t, token);
    const chs = await makeChapters(100, 1, 800);

    const draft = await t.json('POST', `/api/v1/novels/${novel.id}/versions`, {
      token,
      headers: { 'Idempotency-Key': 'k1' },
      body: draftBody(chs),
    });
    expect(draft.status).toBe(201);
    const d = expectSchema(CreateVersionResponseSchema, draft.body);
    expect(d.version.status).toBe('draft');
    expect(d.version.versionNumber).toBe(0);
    expect(d.missingHashes.length).toBe(100);

    // 20 个一批
    let uploaded = 0;
    for (let i = 0; i < chs.length; i += 20) {
      const batch = chs.slice(i, i + 20).map((c) => ({ hash: c.hash, content: c.content }));
      const up = await t.json('POST', '/api/v1/blobs', { token, body: { blobs: batch } });
      expect(up.status).toBe(200);
      const u = expectSchema(UploadBlobsResponseSchema, up.body);
      expect(u.rejected).toEqual([]);
      uploaded += u.accepted.length;
    }
    expect(uploaded).toBe(100);

    const commit = await t.json('POST', `/api/v1/novels/${novel.id}/versions/${d.version.id}/commit`, { token });
    expect(commit.status).toBe(200);
    const c = expectSchema(CommitVersionResponseSchema, commit.body);
    expect(c.version.status).toBe('committed');
    expect(c.version.versionNumber).toBe(1);
    expect(c.version.chapterCount).toBe(100);
    expect(c.version.charCount).toBe(chs.reduce((s, x) => s + x.charCount, 0));
    expect(c.novel.visibility).toBe('public');
    expect(c.novel.currentVersion?.id).toBe(d.version.id);
    expect(c.novel.publishedAt).not.toBeNull();

    // 公开可读
    const list = await t.json('GET', `/api/v1/novels/${novel.id}/versions/current/chapters`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(100);
    expect(list.body.items.length).toBe(100);
    const ch57 = await t.json('GET', `/api/v1/novels/${novel.id}/versions/current/chapters/57`);
    expect(ch57.body.content).toBe(chs[57]!.content);
    expect(ch57.body.prev).toBe(56);
    expect(ch57.body.next).toBe(58);
    const last = await t.json('GET', `/api/v1/novels/${novel.id}/versions/${d.version.id}/chapters/99`);
    expect(last.body.next).toBeNull();
  });

  it('re-POST with same Idempotency-Key returns the same draft (200) with current missingHashes', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const novel = await createNovel(t, token);
    const chs = await makeChapters(5);
    const a = await t.json('POST', `/api/v1/novels/${novel.id}/versions`, { token, headers: { 'Idempotency-Key': 'same' }, body: draftBody(chs) });
    expect(a.status).toBe(201);
    await t.json('POST', '/api/v1/blobs', { token, body: { blobs: chs.slice(0, 2).map((c) => ({ hash: c.hash, content: c.content })) } });
    const b = await t.json('POST', `/api/v1/novels/${novel.id}/versions`, { token, headers: { 'Idempotency-Key': 'same' }, body: draftBody(chs) });
    expect(b.status).toBe(200);
    expect(b.body.version.id).toBe(a.body.version.id);
    expect(b.body.missingHashes.sort()).toEqual(chs.slice(2).map((c) => c.hash).sort());
    // 不同 key → 新草稿
    const c = await t.json('POST', `/api/v1/novels/${novel.id}/versions`, { token, headers: { 'Idempotency-Key': 'other' }, body: draftBody(chs) });
    expect(c.status).toBe(201);
    expect(c.body.version.id).not.toBe(a.body.version.id);
    // 缺 key → 400
    const d = await t.json('POST', `/api/v1/novels/${novel.id}/versions`, { token, body: draftBody(chs) });
    expect(d.status).toBe(400);
  });

  it('resume via GET draft: status + missingHashes', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const novel = await createNovel(t, token);
    const chs = await makeChapters(6);
    const a = await t.json('POST', `/api/v1/novels/${novel.id}/versions`, { token, headers: { 'Idempotency-Key': 'r' }, body: draftBody(chs) });
    await t.json('POST', '/api/v1/blobs', { token, body: { blobs: chs.slice(0, 4).map((c) => ({ hash: c.hash, content: c.content })) } });
    const g = await t.json('GET', `/api/v1/novels/${novel.id}/versions/${a.body.version.id}`, { token });
    expect(g.status).toBe(200);
    const s = expectSchema(VersionStatusResponseSchema, g.body);
    expect(s.version.status).toBe('draft');
    expect(s.missingHashes!.sort()).toEqual(chs.slice(4).map((c) => c.hash).sort());
    // 其他人看不到草稿
    const { token: other } = await t.register('b@example.com');
    expect((await t.json('GET', `/api/v1/novels/${novel.id}/versions/${a.body.version.id}`, { token: other })).status).toBe(404);
  });

  it('rejects blobs whose hash does not match, accepts normalized duplicates', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const good = '第一章\r\n正文  \r\n';
    const hash = await hashChapterContent(good);
    const r = await t.json('POST', '/api/v1/blobs', {
      token,
      body: { blobs: [{ hash, content: good }, { hash: 'a'.repeat(64), content: '别的内容' }] },
    });
    expect(r.status).toBe(200);
    expect(r.body.accepted).toEqual([hash]);
    expect(r.body.rejected).toEqual([{ hash: 'a'.repeat(64), code: 'HASH_MISMATCH' }]);
    const stored = t.deps.db.select().from(blobs).where(eq(blobs.hash, hash)).get()!;
    expect(stored.content).toBe('第一章\n正文');
    expect(stored.charCount).toBe(5);
    // 再传一次同内容：accepted，不重复入库
    const again = await t.json('POST', '/api/v1/blobs', { token, body: { blobs: [{ hash, content: '第一章\n正文' }] } });
    expect(again.body.accepted).toEqual([hash]);
    expect(t.deps.db.select().from(blobs).all().length).toBe(1);
    // 匿名不可上传
    expect((await t.json('POST', '/api/v1/blobs', { body: { blobs: [{ hash, content: good }] } })).status).toBe(401);
  });

  it('commit with missing blobs → 409 BLOBS_MISSING listing them; then succeeds; re-commit is idempotent', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const novel = await createNovel(t, token);
    const chs = await makeChapters(4);
    const a = await t.json('POST', `/api/v1/novels/${novel.id}/versions`, { token, headers: { 'Idempotency-Key': 'c' }, body: draftBody(chs) });
    await t.json('POST', '/api/v1/blobs', { token, body: { blobs: chs.slice(0, 3).map((c) => ({ hash: c.hash, content: c.content })) } });
    const vid = a.body.version.id;
    const fail = await t.json('POST', `/api/v1/novels/${novel.id}/versions/${vid}/commit`, { token });
    expect(fail.status).toBe(409);
    expect(fail.body.error.code).toBe('BLOBS_MISSING');
    expect(fail.body.error.details.missingHashes).toEqual([chs[3]!.hash]);
    await t.json('POST', '/api/v1/blobs', { token, body: { blobs: [{ hash: chs[3]!.hash, content: chs[3]!.content }] } });
    const ok = await t.json('POST', `/api/v1/novels/${novel.id}/versions/${vid}/commit`, { token });
    expect(ok.status).toBe(200);
    expect(ok.body.version.versionNumber).toBe(1);
    const again = await t.json('POST', `/api/v1/novels/${novel.id}/versions/${vid}/commit`, { token });
    expect(again.status).toBe(200);
    expect(again.body.version.id).toBe(vid);
    expect(again.body.version.versionNumber).toBe(1);
    // 同 key 重 POST 已提交版本 → 返回该版本，missingHashes 为空
    const re = await t.json('POST', `/api/v1/novels/${novel.id}/versions`, { token, headers: { 'Idempotency-Key': 'c' }, body: draftBody(chs) });
    expect(re.status).toBe(200);
    expect(re.body.version.status).toBe('committed');
    expect(re.body.missingHashes).toEqual([]);
  });

  it('update changing 3 of 30 chapters uploads exactly 3 blobs and bumps version number', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const novel = await createNovel(t, token);
    const v1 = await makeChapters(30, 7);
    const first = await publish(t, token, novel.id, v1);
    expect(first.uploaded).toBe(30);
    expect(first.version.versionNumber).toBe(1);

    const v2 = [...v1];
    for (const i of [3, 10, 29]) {
      const content = v1[i]!.content + '\n\n新增的一段结尾。';
      v2[i] = { ...v1[i]!, content, hash: await hashChapterContent(content), charCount: v1[i]!.charCount + 8 };
    }
    const second = await publish(t, token, novel.id, v2, { changeNote: '修改三章' });
    expect(second.uploaded).toBe(3);
    expect(second.version.versionNumber).toBe(2);
    expect(second.version.changeNote).toBe('修改三章');
    expect(second.novel.currentVersion?.versionNumber).toBe(2);
    expect(t.deps.db.select().from(blobs).all().length).toBe(33);

    // 老版本仍可读、不可变
    const ch3old = await t.json('GET', `/api/v1/novels/${novel.id}/versions/${first.version.id}/chapters/3`);
    expect(ch3old.body.content).toBe(v1[3]!.content);
    const ch3new = await t.json('GET', `/api/v1/novels/${novel.id}/versions/current/chapters/3`);
    expect(ch3new.body.content).toBe(v2[3]!.content);
    const versions = await t.json('GET', `/api/v1/novels/${novel.id}/versions`);
    expect(versions.body.items.map((v: any) => v.versionNumber)).toEqual([2, 1]);
    // 已提交版本不可删除
    expect((await t.json('DELETE', `/api/v1/novels/${novel.id}/versions/${first.version.id}`, { token })).status).toBe(403);
  });

  it('manifest validation: non-contiguous indexes rejected', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const novel = await createNovel(t, token);
    const chs = await makeChapters(3);
    const m = manifestOf(chs);
    m[2]!.index = 5;
    const r = await t.json('POST', `/api/v1/novels/${novel.id}/versions`, {
      token,
      headers: { 'Idempotency-Key': 'x' },
      body: { storyline: sampleStoryline(), bible: null, chapters: m },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('only the author can publish; drafts are aborted via DELETE and GC after 24h', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const { token: other } = await t.register('b@example.com');
    const novel = await createNovel(t, token);
    const chs = await makeChapters(2);
    const forbidden = await t.json('POST', `/api/v1/novels/${novel.id}/versions`, { token: other, headers: { 'Idempotency-Key': 'z' }, body: draftBody(chs) });
    expect(forbidden.status).toBe(403);

    const a = await t.json('POST', `/api/v1/novels/${novel.id}/versions`, { token, headers: { 'Idempotency-Key': 'd1' }, body: draftBody(chs) });
    const del = await t.json('DELETE', `/api/v1/novels/${novel.id}/versions/${a.body.version.id}`, { token });
    expect(del.status).toBe(200);
    expect((await t.json('GET', `/api/v1/novels/${novel.id}/versions/${a.body.version.id}`, { token })).body.version.status).toBe('aborted');
    const commitAborted = await t.json('POST', `/api/v1/novels/${novel.id}/versions/${a.body.version.id}/commit`, { token });
    expect(commitAborted.status).toBe(409);
    expect(commitAborted.body.error.code).toBe('VERSION_NOT_DRAFT');

    await t.json('POST', `/api/v1/novels/${novel.id}/versions`, { token, headers: { 'Idempotency-Key': 'd2' }, body: draftBody(chs) });
    expect(gcDrafts(t.deps)).toBe(0);
    t.clock.advance(DAY + 1000);
    expect(gcDrafts(t.deps)).toBe(2);
    expect(t.deps.db.select().from(novelVersions).all().length).toBe(0);
  });

  it('moderator failure hides the novel (审核中)', async () => {
    const t = makeTestApp({ moderator: { async check() { return { ok: false, reason: '疑似违规' }; }, async checkText() { return { ok: true }; } } });
    const { token } = await t.register('a@example.com');
    const novel = await createNovel(t, token);
    const { novel: after } = await publish(t, token, novel.id, await makeChapters(2));
    expect(after.moderationStatus).toBe('hidden');
    expect((await t.json('GET', `/api/v1/novels/${novel.id}`)).status).toBe(404);
    expect((await t.json('GET', '/api/v1/novels')).body.items.length).toBe(0);
    expect((await t.json('GET', `/api/v1/novels/${novel.id}`, { token })).status).toBe(200);
  });

  it('enforces body limits with PAYLOAD_TOO_LARGE', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const big = 'x'.repeat(300 * 1024);
    const r = await t.json('PATCH', '/api/v1/auth/me', { token, body: { bio: big } });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
