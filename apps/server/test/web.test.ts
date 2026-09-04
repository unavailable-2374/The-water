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
    expect(html).toContain('还没有发布二创作品。');
    expect(html).toContain(`/u/${handle}/avatar.svg`);
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
    expect(html).toContain(`content="https://water.example/n/${n.id}/cover.svg"`);
    expect(html).toContain('twitter:card');

    const author = await (await t.request('GET', `/u/${handle}`)).text();
    expect(author).toContain(`content="https://water.example/u/${handle}"`);
    expect(author).toContain('property="og:type" content="profile"');
  });
});
