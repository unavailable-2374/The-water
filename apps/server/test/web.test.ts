import { describe, expect, it } from 'bun:test';
import { createNovel, makeChapters, makeTestApp, publish } from './helpers';

describe('web read pages', () => {
  it('renders home, novel and chapter pages with Chinese UI, no scripts, strict CSP', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com', '张三');
    const { token: b } = await t.register('b@example.com', '李四');
    const empty = await t.request('GET', '/');
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain('还没有已发布的作品');

    const n = await createNovel(t, a, { title: '灯下长街', summary: '雪夜守灯人的故事。' });
    const chs = await makeChapters(3, 2, 200);
    await publish(t, a, n.id, chs);
    const f = await t.json('POST', `/api/v1/novels/${n.id}/forks`, { token: b, body: {} });
    const d = await createNovel(t, b, { title: '长街新说', license: 'cc-by-sa', source: { forkId: f.body.fork.id } });
    await publish(t, b, d.id, chs.slice(0, 2));

    const home = await t.request('GET', '/');
    const homeHtml = await home.text();
    expect(home.headers.get('content-type')).toContain('text/html');
    expect(homeHtml).toContain('<html lang="zh-CN">');
    expect(homeHtml).toContain('灯下长街');
    expect(homeHtml).toContain('长街新说');
    expect(homeHtml).toContain('（二创）');
    expect(homeHtml).not.toContain('<script');
    expect(home.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(home.headers.get('X-Frame-Options')).toBeTruthy();

    const novelPage = await t.request('GET', `/n/${d.id}`);
    const nh = await novelPage.text();
    expect(nh).toContain('改编自');
    expect(nh).toContain(`href="/n/${n.id}"`);
    expect(nh).toContain('第 v1 版');
    expect(nh).toContain('张三');
    expect(nh).toContain('CC BY-SA');
    expect(nh).toContain(`/n/${d.id}/c/0`);
    expect(nh).toContain('章节目录');

    const ch = await t.request('GET', `/n/${n.id}/c/1`);
    const ch1 = await ch.text();
    expect(ch1).toContain(chs[1]!.title);
    expect(ch1).toContain(`href="/n/${n.id}/c/0"`);
    expect(ch1).toContain(`href="/n/${n.id}/c/2"`);
    expect(ch1).toContain('上一章');
    expect(ch1).toContain('下一章');
    const firstPara = chs[1]!.content.split('\n\n')[0]!;
    expect(ch1).toContain(`<p>${firstPara}</p>`);
    // 服务端计浏览（同访客同日去重）
    await t.request('GET', `/n/${n.id}/c/2`);
    expect((await t.json('GET', `/api/v1/novels/${n.id}`)).body.novel.viewCount).toBe(1);
    const lastPage = await (await t.request('GET', `/n/${n.id}/c/2`)).text();
    expect(lastPage).toContain('已是最后一章');

    // HTML 转义
    const evil = await createNovel(t, a, { title: '<script>alert(1)</script>', summary: 'x' });
    await publish(t, a, evil.id, chs.slice(0, 1));
    const eh = await (await t.request('GET', `/n/${evil.id}`)).text();
    expect(eh).not.toContain('<script>alert');
    expect(eh).toContain('&lt;script&gt;');
  });

  it('404s for unpublished / unknown / out-of-range', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const n = await createNovel(t, token);
    expect((await t.request('GET', `/n/${n.id}`)).status).toBe(404);
    expect((await t.request('GET', '/n/does-not-exist')).status).toBe(404);
    await publish(t, token, n.id, await makeChapters(1));
    expect((await t.request('GET', `/n/${n.id}/c/5`)).status).toBe(404);
    expect((await t.request('GET', `/n/${n.id}/c/x`)).status).toBe(400);
    expect((await t.request('GET', '/nowhere')).status).toBe(404);
  });
});

describe('web: author page, share images and OG tags', () => {
  it('renders an author page with stats and both work sections', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const handle = (await t.json('GET', '/api/v1/auth/me', { token: a })).body.user.handle;
    const original = await createNovel(t, a, { title: '灯下长街', license: 'cc-by-sa', allowDerivatives: true });
    await publish(t, a, original.id, await makeChapters(1));
    const fork = await t.json('POST', `/api/v1/novels/${original.id}/forks`, { token: b, body: {} });
    const deriv = await createNovel(t, b, { title: '雪夜续', license: 'cc-by-sa', allowDerivatives: true, source: { forkId: fork.body.fork.id } } as never);
    await publish(t, b, deriv.id, await makeChapters(1, 8));

    const res = await t.request('GET', `/u/${handle}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`@${handle}`);
    expect(html).toContain('灯下长街');
    expect(html).toContain('关注者 0');
    expect(html).toContain('被二创 1');
    expect(html).toContain(`/u/${handle}/avatar.svg`);
    // 作者页改成「全部 / 原创 / 二创」筛选 + 分页，二创一栏此时是空的。
    expect(html).toContain('kind=derivative');
    const derivTab = await (await t.request('GET', `/u/${handle}?kind=derivative`)).text();
    expect(derivTab).toContain('还没有发布二创作品。');
    expect((await t.request('GET', '/u/nobody')).status).toBe(404);
  });

  it('serves self-contained svg avatars and covers with escaped text', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const handle = (await t.json('GET', '/api/v1/auth/me', { token: a })).body.user.handle;
    const n = await createNovel(t, a, { title: '<script>alert(1)</script>' });
    await publish(t, a, n.id, await makeChapters(1));

    const avatar = await t.request('GET', `/u/${handle}/avatar.svg`);
    expect(avatar.headers.get('Content-Type')).toContain('image/svg+xml');
    expect(avatar.headers.get('Cache-Control')).toContain('max-age');
    expect(await avatar.text()).toStartWith('<svg');

    const cover = await t.request('GET', `/n/${n.id}/cover.svg`);
    expect(cover.headers.get('Content-Type')).toContain('image/svg+xml');
    const svg = await cover.text();
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;');
    expect((await t.request('GET', '/n/nope/cover.svg')).status).toBe(404);
  });

  it('emits OG tags, with absolute url and image only when PUBLIC_BASE_URL is set', async () => {
    const bare = makeTestApp();
    const { token: a1 } = await bare.register('a@example.com');
    const n1 = await createNovel(bare, a1, { title: '无站点地址' });
    await publish(bare, a1, n1.id, await makeChapters(1));
    const plain = await (await bare.request('GET', `/n/${n1.id}`)).text();
    expect(plain).toContain('og:title');
    expect(plain).toContain('property="og:type" content="book"');
    expect(plain).not.toContain('og:image');
    expect(plain).not.toContain('og:url');

    const t = makeTestApp({ env: { publicBaseUrl: 'https://water.example' } });
    const { token: a } = await t.register('a@example.com');
    const handle = (await t.json('GET', '/api/v1/auth/me', { token: a })).body.user.handle;
    const n = await createNovel(t, a, { title: '有站点地址' });
    await publish(t, a, n.id, await makeChapters(1));
    const html = await (await t.request('GET', `/n/${n.id}`)).text();
    expect(html).toContain(`content="https://water.example/n/${n.id}"`);
    // og:image 换成 PNG：微信 / 推特的抓取器不渲染 SVG。
    expect(html).toContain(`content="https://water.example/n/${n.id}/cover.png"`);
    expect(html).toContain('twitter:card');

    const author = await (await t.request('GET', `/u/${handle}`)).text();
    expect(author).toContain(`content="https://water.example/u/${handle}"`);
    expect(author).toContain('property="og:type" content="profile"');
  });
});

describe('web: 审核后台（P0-6）', () => {
  async function setup() {
    const t = makeTestApp();
    const { token: admin } = await t.register('admin@example.com', '管理员');
    const { token: a } = await t.register('a@example.com', '作者');
    const { token: b, user: bu } = await t.register('b@example.com', '读者');
    const n = await createNovel(t, a, { title: '灯下长街' });
    await publish(t, a, n.id, await makeChapters(1));
    const comment = (await t.json('POST', `/api/v1/novels/${n.id}/comments`, { token: b, body: { body: '广告广告' } })).body.comment;
    const report = (await t.json('POST', `/api/v1/novels/${n.id}/reports`, { token: b, body: { reason: 'spam', detail: '刷屏' } })).body.report;
    const commentReport = (
      await t.json('POST', `/api/v1/novels/${n.id}/comments/${comment.id}/reports`, { token: a, body: { reason: 'spam', detail: '像广告' } })
    ).body.report;
    return { t, admin, a, b, bu, novelId: n.id, comment, report, commentReport };
  }

  const form = (t: any, path: string, fields: Record<string, string>) =>
    t.request('POST', path, {
      raw: new URLSearchParams(fields).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

  it('要求管理员 token，页面列出举报队列、用户与操作记录', async () => {
    const { t, admin, a, novelId, report } = await setup();
    expect((await t.request('GET', '/admin')).status).toBe(401);
    expect((await t.request('GET', '/admin?token=tw_not-a-real-token')).status).toBe(401);
    expect((await t.request('GET', `/admin?token=${a}`)).status).toBe(403);

    const res = await t.request('GET', `/admin?token=${admin}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('审核后台');
    expect(html).toContain('管理员 @');
    expect(html).toContain('灯下长街');
    expect(html).toContain('垃圾信息');
    expect(html).toContain('刷屏');
    expect(html).toContain('广告广告');
    expect(html).toContain('读者');
    expect(html).toContain('action="/admin/actions/novel"');
    expect(html).toContain(`value="${report.id}"`);
    expect(html).toContain(`value="${novelId}"`);
    expect(html).not.toContain('<script');
    // 管理页放开 form-action，阅读页仍然禁止提交。
    expect(res.headers.get('Content-Security-Policy')).toContain("form-action 'self'");
    const home = await t.request('GET', '/');
    expect(home.headers.get('Content-Security-Policy')).toContain("form-action 'none'");
    // Authorization 头也可以。
    expect((await t.request('GET', '/admin', { token: admin })).status).toBe(200);
  });

  it('表单动作走真实审核服务，并记进审计日志', async () => {
    const { t, admin, novelId, comment, report, bu } = await setup();
    const back = `/admin?token=${admin}&reportStatus=open`;

    const hide = await form(t, '/admin/actions/novel', { token: admin, back, id: novelId, moderationStatus: 'hidden', note: '待复核' });
    expect(hide.status).toBe(303);
    expect(hide.headers.get('location')).toBe(back);
    expect((await t.json('GET', `/api/v1/novels/${novelId}`)).status).toBe(404);

    expect((await form(t, '/admin/actions/novel', { token: admin, back, id: novelId, moderationStatus: 'ok' })).status).toBe(303);
    expect((await t.json('GET', `/api/v1/novels/${novelId}`)).status).toBe(200);

    expect((await form(t, '/admin/actions/comment', { token: admin, back, id: comment.id, action: 'hide' })).status).toBe(303);
    expect((await t.json('GET', `/api/v1/novels/${novelId}/comments`)).body.items).toEqual([]);
    expect((await form(t, '/admin/actions/comment', { token: admin, back, id: comment.id, action: 'restore' })).status).toBe(303);

    expect((await form(t, '/admin/actions/report', { token: admin, back, id: report.id, status: 'dismissed', note: '误报' })).status).toBe(303);
    expect((await t.json('GET', '/api/v1/admin/reports?status=dismissed', { token: admin })).body.items.length).toBe(1);

    expect((await form(t, '/admin/actions/ban', { token: admin, back, id: bu.id, reason: '刷屏', days: '3' })).status).toBe(303);
    const suspended = (await t.json('GET', `/api/v1/admin/users?q=b@example.com`, { token: admin })).body.items[0];
    expect(suspended.status).toBe('suspended');
    expect(suspended.suspendedUntil).toBe(new Date(t.clock.now().getTime() + 3 * 86_400_000).toISOString());
    expect((await form(t, '/admin/actions/unban', { token: admin, back, id: bu.id })).status).toBe(303);
    expect((await t.json('GET', `/api/v1/admin/users?q=b@example.com`, { token: admin })).body.items[0].status).toBe('active');

    const events = (await t.json('GET', '/api/v1/admin/moderation-events?limit=50', { token: admin })).body.items;
    const adminId = (await t.json('GET', '/api/v1/auth/me', { token: admin })).body.user.id;
    expect(events.map((e: { action: string }) => e.action).sort()).toEqual(
      ['comment_hide', 'comment_restore', 'novel_hide', 'novel_restore', 'report_dismiss', 'user_suspend', 'user_unban'].sort(),
    );
    for (const e of events) expect(e.actorId).toBe(adminId);
  });

  it('动作端点同样要求管理员，且不接受站外跳转', async () => {
    const { t, admin, b, novelId } = await setup();
    const evil = 'https://evil.example/';
    expect((await form(t, '/admin/actions/novel', { token: b, back: evil, id: novelId, moderationStatus: 'removed' })).status).toBe(403);
    expect((await form(t, '/admin/actions/novel', { back: evil, id: novelId, moderationStatus: 'removed' })).status).toBe(401);
    const ok = await form(t, '/admin/actions/novel', { token: admin, back: evil, id: novelId, moderationStatus: 'removed' });
    expect(ok.headers.get('location')).toBe(`/admin?token=${encodeURIComponent(admin)}`);
    // 缺 id / 状态非法都要报错，不能静默通过。
    expect((await form(t, '/admin/actions/novel', { token: admin, moderationStatus: 'ok' })).status).toBe(400);
    expect((await form(t, '/admin/actions/novel', { token: admin, id: novelId, moderationStatus: 'nope' })).status).toBe(400);
    expect((await form(t, '/admin/actions/ban', { token: admin, id: novelId })).status).toBe(400);
  });
});
