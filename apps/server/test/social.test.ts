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

  it('reports require login, dedupe per reporter; admins list and moderate', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: b, user: bu } = await t.register('b@example.com');
    const { token: admin, user: adminUser } = await t.register('admin@example.com');
    const n = await createNovel(t, a);
    await publish(t, a, n.id, await makeChapters(1));

    // 契约变更（P0-6）：匿名举报不再受理，零成本刷爆举报队列的路径被关掉。
    expect((await t.json('POST', `/api/v1/novels/${n.id}/reports`, { body: { reason: 'spam' } })).status).toBe(401);
    const r1 = await t.json('POST', `/api/v1/novels/${n.id}/reports`, { token: admin, body: { reason: 'spam' } });
    expect(r1.status).toBe(201);
    expect(ReportResponseSchema.parse(r1.body).report.reporterId).toBe(adminUser.id);
    const r2 = await t.json('POST', `/api/v1/novels/${n.id}/reports`, { token: b, body: { reason: 'plagiarism', detail: '抄袭了某书' } });
    expect(r2.body.report.reporterId).toBe(bu.id);
    // 同人同对象重复举报返回既有记录，不再新增队列条目。
    const dup = await t.json('POST', `/api/v1/novels/${n.id}/reports`, { token: b, body: { reason: 'other', detail: '再报一次' } });
    expect(dup.status).toBe(201);
    expect(dup.body.report.id).toBe(r2.body.report.id);
    expect(dup.body.report.reason).toBe('plagiarism');
    expect((await t.json('POST', `/api/v1/novels/${n.id}/reports`, { token: b, body: { reason: 'nope' } })).status).toBe(400);

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

  it('X-Client-Id 与 IP 前缀绑定：同 client id 换网段才算新访客（§3.3）', async () => {
    const t = makeTestApp({ env: { trustProxy: true } });
    const { token: a } = await t.register('a@example.com');
    const n = await createNovel(t, a);
    await publish(t, a, n.id, await makeChapters(1));
    const view = (cid: string, ip: string) =>
      t.json('POST', `/api/v1/novels/${n.id}/view`, { headers: { 'X-Client-Id': cid, 'X-Forwarded-For': ip } });

    expect((await view('visitor-aaaaaaaa', '203.0.113.5')).body).toEqual({ viewCount: 1, counted: true });
    // 同一 /24 内换 IP 尾数不算新访客。
    expect((await view('visitor-aaaaaaaa', '203.0.113.99')).body).toEqual({ viewCount: 1, counted: false });
    // 换网段才是另一个访客。
    expect((await view('visitor-aaaaaaaa', '198.51.100.7')).body).toEqual({ viewCount: 2, counted: true });
  });

  it('举报限流：超出 report 规则返回 429', async () => {
    const t = makeTestApp({ rateLimits: { report: { max: 1, windowMs: 60_000 } } });
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const n1 = await createNovel(t, a, { title: '一' });
    await publish(t, a, n1.id, await makeChapters(1));
    const n2 = await createNovel(t, a, { title: '二' });
    await publish(t, a, n2.id, await makeChapters(1, 3));

    expect((await t.json('POST', `/api/v1/novels/${n1.id}/reports`, { token: b, body: { reason: 'spam' } })).status).toBe(201);
    const limited = await t.json('POST', `/api/v1/novels/${n2.id}/reports`, { token: b, body: { reason: 'spam' } });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
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
