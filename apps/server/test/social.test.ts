import { describe, expect, it } from 'bun:test';
import { LikeResponseSchema, NovelListResponseSchema, ReportListResponseSchema, ReportResponseSchema } from '@the-water/shared';
import { createNovel, makeChapters, makeTestApp, publish } from './helpers';

describe('social & admin', () => {
  it('like / unlike are idempotent and reflected in counts and /me/likes', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const n = await createNovel(t, a);
    await publish(t, a, n.id, await makeChapters(1));
    const n2 = await createNovel(t, a, { title: '第二本' });
    await publish(t, a, n2.id, await makeChapters(1, 5));

    expect((await t.json('PUT', `/api/v1/novels/${n.id}/like`)).status).toBe(401);
    const l1 = await t.json('PUT', `/api/v1/novels/${n.id}/like`, { token: b });
    expect(LikeResponseSchema.parse(l1.body)).toEqual({ liked: true, likeCount: 1 });
    expect((await t.json('PUT', `/api/v1/novels/${n.id}/like`, { token: b })).body).toEqual({ liked: true, likeCount: 1 });
    expect((await t.json('PUT', `/api/v1/novels/${n.id}/like`, { token: a })).body.likeCount).toBe(2);
    t.clock.advance(1000);
    await t.json('PUT', `/api/v1/novels/${n2.id}/like`, { token: b });

    const mine = await t.json('GET', '/api/v1/me/likes', { token: b });
    expect(NovelListResponseSchema.parse(mine.body).items.map((x) => x.id)).toEqual([n2.id, n.id]);
    const detail = await t.json('GET', `/api/v1/novels/${n.id}`, { token: b });
    expect(detail.body.novel.viewer.liked).toBe(true);
    expect(detail.body.novel.likeCount).toBe(2);

    const u = await t.json('DELETE', `/api/v1/novels/${n.id}/like`, { token: b });
    expect(u.body).toEqual({ liked: false, likeCount: 1 });
    expect((await t.json('DELETE', `/api/v1/novels/${n.id}/like`, { token: b })).body).toEqual({ liked: false, likeCount: 1 });
    expect((await t.json('GET', '/api/v1/me/likes', { token: b })).body.items.map((x: any) => x.id)).toEqual([n2.id]);
    expect((await t.json('PUT', '/api/v1/novels/nope/like', { token: b })).status).toBe(404);
  });

  it('reports can be filed anonymously or logged in; admins list and moderate', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: b, user: bu } = await t.register('b@example.com');
    const { token: admin } = await t.register('admin@example.com');
    const n = await createNovel(t, a);
    await publish(t, a, n.id, await makeChapters(1));

    const r1 = await t.json('POST', `/api/v1/novels/${n.id}/reports`, { body: { reason: 'spam' } });
    expect(r1.status).toBe(201);
    expect(ReportResponseSchema.parse(r1.body).report.reporterId).toBeNull();
    const r2 = await t.json('POST', `/api/v1/novels/${n.id}/reports`, { token: b, body: { reason: 'plagiarism', detail: '抄袭了某书' } });
    expect(r2.body.report.reporterId).toBe(bu.id);
    expect((await t.json('POST', `/api/v1/novels/${n.id}/reports`, { body: { reason: 'nope' } })).status).toBe(400);

    expect((await t.json('GET', '/api/v1/admin/reports')).status).toBe(401);
    expect((await t.json('GET', '/api/v1/admin/reports', { token: b })).status).toBe(403);
    const list = await t.json('GET', '/api/v1/admin/reports?status=open', { token: admin });
    expect(list.status).toBe(200);
    expect(ReportListResponseSchema.parse(list.body).items.length).toBe(2);

    const resolved = await t.json('PATCH', `/api/v1/admin/reports/${r1.body.report.id}`, { token: admin, body: { status: 'dismissed', note: '无问题' } });
    expect(resolved.status).toBe(200);
    expect(resolved.body.report.status).toBe('dismissed');

    const mod = await t.json('PATCH', `/api/v1/admin/novels/${n.id}/moderation`, { token: admin, body: { moderationStatus: 'removed', note: '确认抄袭' } });
    expect(mod.status).toBe(200);
    expect(mod.body.novel.moderationStatus).toBe('removed');
    expect((await t.json('GET', '/api/v1/admin/reports?status=open', { token: admin })).body.items.length).toBe(0);
    expect((await t.json('GET', `/api/v1/novels/${n.id}`)).status).toBe(404);
    // 恢复
    const back = await t.json('PATCH', `/api/v1/admin/novels/${n.id}/moderation`, { token: admin, body: { moderationStatus: 'ok' } });
    expect(back.body.novel.moderationStatus).toBe('ok');
    expect((await t.json('GET', `/api/v1/novels/${n.id}`)).status).toBe(200);
  });

  it('health, request ids, CORS, unknown routes', async () => {
    const t = makeTestApp();
    const h = await t.json('GET', '/health');
    expect(h.status).toBe(200);
    expect(h.body.ok).toBe(true);
    expect((await t.json('GET', '/api/v1/health')).status).toBe(200);
    const nf = await t.json('GET', '/api/v1/nothing-here');
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe('NOT_FOUND');
    const echo = await t.request('GET', '/health', { headers: { 'X-Request-Id': 'abc-123' } });
    expect(echo.headers.get('X-Request-Id')).toBe('abc-123');
    const pre = await t.request('OPTIONS', '/api/v1/novels', {
      headers: { Origin: 'tauri://localhost', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Idempotency-Key' },
    });
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe('tauri://localhost');
    expect(pre.headers.get('Access-Control-Allow-Headers')).toContain('Idempotency-Key');
    const bad = await t.request('GET', '/api/v1/novels', { headers: { Origin: 'https://evil.example' } });
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBeNull();
    // gzip
    const gz = await t.request('GET', '/api/v1/novels', { headers: { 'Accept-Encoding': 'gzip' } });
    expect(gz.headers.get('Content-Encoding')).toBe('gzip');
    const text = await new Response(gz.body!.pipeThrough(new DecompressionStream('gzip'))).text();
    expect(JSON.parse(text)).toEqual({ items: [], nextCursor: null });
  });
});
