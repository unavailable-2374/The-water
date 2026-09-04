import { describe, expect, it } from 'bun:test';
import { createNovel, makeChapters, makeTestApp, publish, type TestApp } from './helpers';
import { chapterSitemapSlice, publicChapterTotal } from '../src/web/query';

/** 批量造已发布作品，返回按创建顺序的 id。 */
async function seedNovels(t: TestApp, token: string, count: number, prefix = '书'): Promise<string[]> {
  const chs = await makeChapters(1, 1, 60);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const n = await createNovel(t, token, { title: `${prefix}${String(i).padStart(2, '0')}`, tags: i % 2 === 0 ? ['悬疑'] : ['言情'] });
    await publish(t, token, n.id, chs);
    ids.push(n.id);
    t.clock.advance(1000);
  }
  return ids;
}

describe('web 分页（§3.5-1）', () => {
  it('首页按 20 本分页，带 rel=prev/next 与页码导航', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    await seedNovels(t, token, 23);

    const p1 = await t.request('GET', '/');
    const h1 = await p1.text();
    expect(p1.status).toBe(200);
    expect(h1).toContain('书22'); // 最新的在第一页
    expect(h1).not.toContain('>书02<');
    expect(h1).toContain('rel="next" href="/?page=2"');
    expect(h1).not.toContain('rel="prev"');
    expect(h1).toContain('第 1 / 2 页');

    const h2 = await (await t.request('GET', '/?page=2')).text();
    expect(h2).toContain('书02');
    expect(h2).toContain('rel="prev" href="/"');
    expect(h2).not.toContain('rel="next"');
    expect(h2).toContain('第 2 / 2 页');

    // 越界页码收敛到最后一页，而不是 404 或崩掉。
    const h9 = await (await t.request('GET', '/?page=99')).text();
    expect(h9).toContain('第 2 / 2 页');
    expect((await t.request('GET', '/?page=abc')).status).toBe(200);
  });

  it('超过 200 章的书，第 201 章在网页上能被翻到（旧硬上限的回归用例）', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const n = await createNovel(t, token, { title: '长卷' });
    const chs = await makeChapters(210, 3, 40);
    await publish(t, token, n.id, chs);

    const p1 = await (await t.request('GET', `/n/${n.id}`)).text();
    expect(p1).toContain('共 210 章');
    expect(p1).toContain(`/n/${n.id}/c/0"`);
    expect(p1).toContain(`/n/${n.id}/c/99"`);
    expect(p1).not.toContain(`/n/${n.id}/c/100"`);
    expect(p1).toContain('rel="next"');
    expect(p1).toContain('第 1 / 3 页');

    const p3 = await (await t.request('GET', `/n/${n.id}?p=3`)).text();
    // 关键断言：第 201 章（index 200）此前根本渲染不出来。
    expect(p3).toContain(`/n/${n.id}/c/200"`);
    expect(p3).toContain(`/n/${n.id}/c/209"`);
    expect(p3).toContain('rel="prev"');
    expect(p3).not.toContain('rel="next"');
    // 末页边界：第 210 章正文可读，且是最后一章。
    const last = await (await t.request('GET', `/n/${n.id}/c/209`)).text();
    expect(last).toContain('已是最后一章');
    expect((await t.request('GET', `/n/${n.id}/c/210`)).status).toBe(404);
  }, 60_000);

  it('作者页分页并支持原创 / 二创筛选', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const handle = (await t.json('GET', '/api/v1/auth/me', { token })).body.user.handle;
    await seedNovels(t, token, 22, '作');

    const page1 = await (await t.request('GET', `/u/${handle}`)).text();
    expect(page1).toContain('共 22 本');
    expect(page1).toContain('第 1 / 2 页');
    expect(page1).toContain(`rel="next" href="/u/${handle}?page=2"`);
    const page2 = await (await t.request('GET', `/u/${handle}?page=2`)).text();
    expect(page2).toContain('作00');
    expect(page2).toContain('第 2 / 2 页');
    const originals = await (await t.request('GET', `/u/${handle}?kind=original`)).text();
    expect(originals).toContain('共 22 本');
  }, 30_000);
});

describe('web 浏览页（§3.5-2）', () => {
  async function setup() {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const a = await createNovel(t, token, { title: '雪夜列车', summary: '一列开往北方的车。', tags: ['悬疑', '短篇'] });
    await publish(t, token, a.id, await makeChapters(1, 1, 60));
    const b = await createNovel(t, token, { title: '春日食堂', summary: '关于饭菜与告别。', tags: ['治愈'], writingStatus: 'completed', license: 'cc0' });
    await publish(t, token, b.id, await makeChapters(2, 2, 60));
    return { t, token, a, b };
  }

  it('关键词 / 标签 / 排序 / 状态 / 只看原创都能零 JS 用起来', async () => {
    const { t, a, b } = await setup();
    const base = await (await t.request('GET', '/browse')).text();
    expect(base).toContain('浏览作品');
    expect(base).toContain('<form class="filters" method="get" action="/browse"');
    expect(base).toContain('雪夜列车');
    expect(base).toContain('春日食堂');

    const q = await (await t.request('GET', '/browse?q=' + encodeURIComponent('列车'))).text();
    expect(q).toContain('搜索「列车」');
    expect(q).toContain('雪夜列车');
    expect(q).not.toContain('春日食堂');

    const tag = await (await t.request('GET', '/browse?tag=' + encodeURIComponent('治愈'))).text();
    expect(tag).toContain('标签「治愈」');
    expect(tag).toContain('春日食堂');
    expect(tag).not.toContain('>雪夜列车<');

    const done = await (await t.request('GET', '/browse?status=completed')).text();
    expect(done).toContain('春日食堂');
    expect(done).not.toContain('>雪夜列车<');

    const lic = await (await t.request('GET', '/browse?license=cc0')).text();
    expect(lic).toContain('春日食堂');

    const empty = await (await t.request('GET', '/browse?q=' + encodeURIComponent('不存在的书'))).text();
    expect(empty).toContain('没有符合条件的作品');

    // 排序页可直达（热门入口）。
    const hot = await (await t.request('GET', '/browse?sort=popular'));
    expect(hot.status).toBe(200);
    expect(await hot.text()).toContain('最多阅读');
    expect(a.id && b.id).toBeTruthy();
  });

  it('标签目录页列出全部标签，链接回浏览页', async () => {
    const { t } = await setup();
    const html = await (await t.request('GET', '/tags')).text();
    expect(html).toContain('标签目录');
    expect(html).toContain('悬疑');
    expect(html).toContain('治愈');
    expect(html).toContain(`/browse?tag=${encodeURIComponent('治愈')}`);
  });

  it('只有浏览页与管理页放开 form-action，阅读页仍然是 none', async () => {
    const { t, a } = await setup();
    const browse = await t.request('GET', '/browse');
    expect(browse.headers.get('Content-Security-Policy')).toContain("form-action 'self'");
    const reading = await t.request('GET', `/n/${a.id}`);
    expect(reading.headers.get('Content-Security-Policy')).toContain("form-action 'none'");
    expect(reading.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    // 浏览页也依然没有客户端脚本（JSON-LD 只出现在作品 / 章节 / 作者页）。
    expect(await browse.text()).not.toContain('<script');
  });
});

describe('web SEO 基础（§3.5-3）', () => {
  async function setup() {
    const t = makeTestApp({ env: { publicBaseUrl: 'https://water.example' } });
    const { token } = await t.register('a@example.com');
    const handle = (await t.json('GET', '/api/v1/auth/me', { token })).body.user.handle;
    const n = await createNovel(t, token, { title: '灯下长街' });
    await publish(t, token, n.id, await makeChapters(3, 1, 60));
    return { t, token, handle, novelId: n.id };
  }

  it('robots.txt 指向站点地图并挡住管理页', async () => {
    const { t } = await setup();
    const res = await t.request('GET', '/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('User-agent: *');
    expect(body).toContain('Disallow: /admin');
    expect(body).toContain('Sitemap: https://water.example/sitemap.xml');
  });

  it('sitemap 是分片索引，作品 / 章节 / 作者三类分片都能取到', async () => {
    const { t, novelId, handle } = await setup();
    const index = await t.request('GET', '/sitemap.xml');
    expect(index.status).toBe(200);
    expect(index.headers.get('Content-Type')).toContain('xml');
    const ix = await index.text();
    expect(ix).toContain('<sitemapindex');
    expect(ix).toContain('https://water.example/sitemap-novels-1.xml');
    expect(ix).toContain('https://water.example/sitemap-chapters-1.xml');
    expect(ix).toContain('https://water.example/sitemap-authors-1.xml');

    const novels = await (await t.request('GET', '/sitemap-novels-1.xml')).text();
    expect(novels).toContain('<urlset');
    expect(novels).toContain('https://water.example/');
    expect(novels).toContain(`https://water.example/n/${novelId}`);

    const chapters = await (await t.request('GET', '/sitemap-chapters-1.xml')).text();
    expect(chapters).toContain(`https://water.example/n/${novelId}/c/0`);
    expect(chapters).toContain(`https://water.example/n/${novelId}/c/2`);
    expect(chapters).not.toContain(`/c/3<`);

    const authors = await (await t.request('GET', '/sitemap-authors-1.xml')).text();
    expect(authors).toContain(`https://water.example/u/${handle}`);
  });

  it('章节分片按全局章节序号切，跨作品也不重不漏', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const n1 = await createNovel(t, token, { title: '甲' });
    await publish(t, token, n1.id, await makeChapters(3, 1, 40));
    t.clock.advance(1000);
    const n2 = await createNovel(t, token, { title: '乙' });
    await publish(t, token, n2.id, await makeChapters(4, 2, 40));

    expect(publicChapterTotal(t.deps)).toBe(7);
    // 乙（更新更晚）排在前面，占全局 [0,4)，甲占 [4,7)。
    const first = chapterSitemapSlice(t.deps, 0, 4);
    expect(first.map((s) => [s.id, s.start, s.end])).toEqual([[n2.id, 0, 4]]);
    const cross = chapterSitemapSlice(t.deps, 3, 6);
    expect(cross.map((s) => [s.id, s.start, s.end])).toEqual([
      [n2.id, 3, 4],
      [n1.id, 0, 2],
    ]);
    expect(chapterSitemapSlice(t.deps, 7, 10)).toEqual([]);
  });

  it('RSS：全站更新源与单本连载源', async () => {
    const { t, novelId } = await setup();
    const site = await t.request('GET', '/feed.xml');
    expect(site.status).toBe(200);
    expect(site.headers.get('Content-Type')).toContain('application/rss+xml');
    const siteXml = await site.text();
    expect(siteXml).toContain('<rss version="2.0"');
    expect(siteXml).toContain('灯下长街');
    expect(siteXml).toContain(`https://water.example/n/${novelId}</link>`);

    const feed = await t.request('GET', `/n/${novelId}/feed.xml`);
    expect(feed.status).toBe(200);
    const feedXml = await feed.text();
    expect(feedXml).toContain('灯下长街 · 更新');
    // 新章在前。
    expect(feedXml.indexOf('/c/2')).toBeLessThan(feedXml.indexOf('/c/0'));
    expect((await t.request('GET', '/n/does-not-exist/feed.xml')).status).toBe(404);
  });

  it('canonical 与 JSON-LD：Book / Chapter / ProfilePage，且对标题做 \\u 转义', async () => {
    const { t, novelId, handle } = await setup();
    const novel = await (await t.request('GET', `/n/${novelId}`)).text();
    expect(novel).toContain(`<link rel="canonical" href="https://water.example/n/${novelId}"/>`);
    expect(novel).toContain('"@type":"Book"');
    expect(novel).toContain('"@type":"Chapter"');
    expect(novel).toContain('<link rel="alternate" type="application/rss+xml"');

    const chapter = await (await t.request('GET', `/n/${novelId}/c/1`)).text();
    expect(chapter).toContain(`<link rel="canonical" href="https://water.example/n/${novelId}/c/1"/>`);
    expect(chapter).toContain('"@type":"Chapter"');
    expect(chapter).toContain('"isPartOf"');
    expect(chapter).toContain(`rel="prev" href="/n/${novelId}/c/0"`);
    expect(chapter).toContain(`rel="next" href="/n/${novelId}/c/2"`);

    const author = await (await t.request('GET', `/u/${handle}`)).text();
    expect(author).toContain('"@type":"ProfilePage"');

    // 章节页也带 og:*，分享单章时卡片仍然有书封。
    expect(chapter).toContain('property="og:type" content="article"');
    expect(chapter).toContain(`content="https://water.example/n/${novelId}/c/1"`);
    expect(chapter).toContain(`content="https://water.example/n/${novelId}/cover.png"`);

    // JSON-LD 里的 < > 必须是 \u 转义，否则标题能提前闭合 script 块。
    const { token } = await t.register('x@example.com');
    const evil = await createNovel(t, token, { title: '</script><script>alert(1)</script>' });
    await publish(t, token, evil.id, await makeChapters(1, 1, 40));
    const evilHtml = await (await t.request('GET', `/n/${evil.id}`)).text();
    expect(evilHtml).not.toContain('</script><script>alert');
    expect(evilHtml).toContain('\\u003c/script\\u003e');
  });
});

describe('web PNG 封面（§3.5-4）', () => {
  it('/n/:id/cover.png 输出真 PNG，og:image 指向它', async () => {
    const t = makeTestApp({ env: { publicBaseUrl: 'https://water.example' } });
    const { token } = await t.register('a@example.com');
    const n = await createNovel(t, token, { title: '灯下长街' });
    await publish(t, token, n.id, await makeChapters(1, 1, 60));

    const res = await t.request('GET', `/n/${n.id}/cover.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toContain('max-age');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR 里的宽高：1200×630。
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(16)).toBe(1200);
    expect(view.getUint32(20)).toBe(630);
    expect(bytes.length).toBeGreaterThan(1000);

    const html = await (await t.request('GET', `/n/${n.id}`)).text();
    expect(html).toContain(`content="https://water.example/n/${n.id}/cover.png"`);
    expect(html).toContain('twitter:card" content="summary_large_image"');
    // SVG 版仍在，供站内使用。
    expect((await t.request('GET', `/n/${n.id}/cover.svg`)).status).toBe(200);
    expect((await t.request('GET', '/n/nope/cover.png')).status).toBe(404);
  }, 60_000);

  it('作者头像也提供 PNG，og:image 指向它', async () => {
    const t = makeTestApp({ env: { publicBaseUrl: 'https://water.example' } });
    const { token } = await t.register('a@example.com');
    const handle = (await t.json('GET', '/api/v1/auth/me', { token })).body.user.handle;
    const res = await t.request('GET', `/u/${handle}/avatar.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const html = await (await t.request('GET', `/u/${handle}`)).text();
    expect(html).toContain(`content="https://water.example/u/${handle}/avatar.png"`);
    expect(html).toContain('twitter:card" content="summary"');
    expect((await t.request('GET', '/u/nobody/avatar.png')).status).toBe(404);
  }, 60_000);
});

describe('web 转化入口 / 移动端 / 阅读偏好（§3.5-5,6,7）', () => {
  async function setup() {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const n = await createNovel(t, token, { title: '灯下长街' });
    await publish(t, token, n.id, await makeChapters(3, 1, 60));
    return { t, novelId: n.id };
  }

  it('每页底部都有 CTA，并有一个下载 / 注册落地页', async () => {
    const { t, novelId } = await setup();
    for (const path of ['/', `/n/${novelId}`, `/n/${novelId}/c/0`, '/browse']) {
      const html = await (await t.request('GET', path)).text();
      expect(html).toContain('下载桌面端 ›');
      expect(html).toContain('/download#register');
    }
    const dl = await t.request('GET', '/download');
    expect(dl.status).toBe(200);
    const html = await dl.text();
    expect(html).toContain('下载桌面端');
    expect(html).toContain('id="register"');
    // 未配置下载地址时明确说明，不编一个假链接。
    expect(html).toContain('DOWNLOAD_URL');
  });

  it('目录在窄屏是单栏，宽屏才两栏（纯 CSS）', async () => {
    const { t, novelId } = await setup();
    const html = await (await t.request('GET', `/n/${novelId}`)).text();
    expect(html).toContain('ol.toc{padding-left:2em;columns:1}');
    expect(html).toContain('@media (min-width:560px){ol.toc{columns:2');
    // CSS 里的 > 不能被转义成实体，否则选择器直接失效。
    expect(html).toContain('.prefs .row>span:first-child');
  });

  it('阅读偏好走 query + Cookie，零 JS 且不放开 CSP', async () => {
    const { t, novelId } = await setup();
    const plain = await t.request('GET', `/n/${novelId}/c/1`);
    expect(await plain.text()).toContain('<body class="fs-md lh-normal w-normal th-auto">');

    const styled = await t.request('GET', `/n/${novelId}/c/1?fs=lg&th=sepia&w=wide`);
    const styledHtml = await styled.text();
    expect(styledHtml).toContain('<body class="fs-lg lh-normal w-wide th-sepia">');
    // 偏好条是链接，不是表单；阅读页 CSP 仍然禁止提交。
    expect(styledHtml).toContain('aria-label="阅读偏好"');
    expect(styledHtml).not.toContain('<form');
    // 页面上唯一的 script 是 JSON-LD 数据块，没有可执行脚本（CSP 的 script-src 继承 default-src 'none'）。
    expect(styledHtml.split('<script').length - 1).toBe(1);
    expect(styledHtml).toContain('<script type="application/ld+json">');
    expect(styled.headers.get('Content-Security-Policy')).toContain("form-action 'none'");
    // 翻页链接把偏好带上，即使浏览器禁了 Cookie 也不会掉。
    expect(styledHtml).toContain(`href="/n/${novelId}/c/2?fs=lg&amp;w=wide&amp;th=sepia"`);
    const cookie = styled.headers.get('Set-Cookie') ?? '';
    expect(cookie).toContain('tw_read=');
    expect(cookie).toContain('SameSite=Lax');
    expect(styled.headers.get('Vary')).toContain('Cookie');

    // 带上 Cookie 后，不写 query 也保持偏好，且跨作品页生效。
    const raw = cookie.split(';')[0]!;
    const again = await t.request('GET', `/n/${novelId}/c/0`, { headers: { cookie: raw } });
    expect(await again.text()).toContain('<body class="fs-lg lh-normal w-wide th-sepia">');
    const home = await t.request('GET', '/', { headers: { cookie: raw } });
    expect(await home.text()).toContain('class="fs-lg lh-normal w-wide th-sepia"');
    // 非法值一律回落默认。
    const bad = await t.request('GET', `/n/${novelId}/c/0?fs=huge&th=neon`);
    expect(await bad.text()).toContain('<body class="fs-md lh-normal w-normal th-auto">');
  });

  it('语义化与无障碍：lang、跳转链接、landmark 与标题层级', async () => {
    const { t, novelId } = await setup();
    const html = await (await t.request('GET', `/n/${novelId}/c/0`)).text();
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('<a class="skip" href="#main">跳到正文</a>');
    expect(html).toContain('<main id="main">');
    expect(html).toContain('<header class="site">');
    expect(html).toContain('<footer class="site">');
    expect(html).toContain('aria-label="站点导航"');
    expect(html).toContain('aria-label="章节导航"');
    expect(html).toContain('<article class="chapter">');
    // 每页只有一个 h1。
    expect(html.split('<h1>').length - 1).toBe(1);
  });
});
