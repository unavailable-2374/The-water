import type { FC, PropsWithChildren } from 'hono/jsx';
import { DEFAULT_PREFS, prefsClass, type ReadPrefs } from './prefs';

const CSS = `
:root{color-scheme:light dark;--fg:#222;--bg:#fbfaf7;--muted:#777;--line:#e5e2dc;--link:#2a5d9f;--accent:#2a5d9f;--fsz:16px;--lh:1.8;--w:760px}
@media (prefers-color-scheme:dark){:root{--fg:#e8e6e1;--bg:#1a1917;--muted:#999;--line:#333;--link:#8ab4f8;--accent:#8ab4f8}}
/* 阅读偏好：服务端把 class 直接写在 body 上，零 JS。 */
body.fs-sm{--fsz:15px}body.fs-md{--fsz:16px}body.fs-lg{--fsz:18px}body.fs-xl{--fsz:21px}
body.lh-tight{--lh:1.55}body.lh-normal{--lh:1.8}body.lh-loose{--lh:2.15}
body.w-narrow{--w:620px}body.w-normal{--w:760px}body.w-wide{--w:920px}
body.th-light{color-scheme:light;--fg:#222;--bg:#fbfaf7;--muted:#777;--line:#e5e2dc;--link:#2a5d9f;--accent:#2a5d9f}
body.th-sepia{color-scheme:light;--fg:#4a3f30;--bg:#f4ecd8;--muted:#8a7a63;--line:#ddd0b4;--link:#8a5a2b;--accent:#8a5a2b}
body.th-dark{color-scheme:dark;--fg:#e8e6e1;--bg:#1a1917;--muted:#999;--line:#333;--link:#8ab4f8;--accent:#8ab4f8}
*{box-sizing:border-box}
body{margin:0;font:var(--fsz)/var(--lh) -apple-system,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:var(--w);margin:0 auto;padding:24px 20px 48px}a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
.skip{position:absolute;left:-9999px;top:0;padding:8px 12px;background:var(--bg);border:1px solid var(--line);z-index:9}
.skip:focus{left:8px;top:8px}
header.site{border-bottom:1px solid var(--line)}
header.site .bar{max-width:var(--w);margin:0 auto;padding:12px 20px;display:flex;flex-wrap:wrap;gap:6px 16px;justify-content:space-between;align-items:baseline}
header.site .brand{font-weight:600;color:var(--fg)}
nav.site-nav{display:flex;flex-wrap:wrap;gap:14px;font-size:14px}
.muted{color:var(--muted);font-size:.875em}
.profile{display:flex;gap:16px;align-items:center;margin:8px 0 4px}.profile img{width:72px;height:72px;border-radius:50%}
.stats{display:flex;flex-wrap:wrap;gap:14px;margin:10px 0 20px;font-size:14px;color:var(--muted)}
.badges span{display:inline-block;margin:0 6px 6px 0;padding:1px 9px;border:1px solid var(--line);border-radius:10px;font-size:12px}
ul.list{list-style:none;padding:0;margin:0}ul.list li{padding:14px 0;border-bottom:1px solid var(--line)}
ul.list h3{margin:0 0 4px;font-size:1.125em}
.tags a,.tags span{display:inline-block;margin:0 6px 6px 0;padding:0 8px;border:1px solid var(--line);border-radius:10px;font-size:13px}
ol.toc{padding-left:2em;columns:1}ol.toc li{break-inside:avoid}
@media (min-width:560px){ol.toc{columns:2;column-gap:32px}}
article.chapter p{text-indent:2em;margin:0 0 1em}
nav.pager{display:flex;flex-wrap:wrap;gap:8px 16px;justify-content:space-between;margin:32px 0 0;padding-top:16px;border-top:1px solid var(--line)}
nav.pages{display:flex;flex-wrap:wrap;gap:8px;margin:20px 0 0;padding-top:14px;border-top:1px solid var(--line);font-size:14px;align-items:center}
nav.pages a,nav.pages strong{padding:2px 9px;border:1px solid var(--line);border-radius:4px}
nav.pages strong{background:var(--line)}
h1{font-size:1.6em;margin:8px 0;line-height:1.35}h2{font-size:1.25em;margin:28px 0 12px}h3{line-height:1.4}
.origin{padding:10px 14px;border-left:3px solid var(--accent);background:rgba(127,127,127,.08);margin:16px 0}
.card{border:1px solid var(--line);border-radius:6px;padding:12px 14px;margin:0 0 14px}
.admin-form{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0 0}
.admin-form input,.admin-form select{flex:1 1 160px;min-width:0;padding:5px 8px;border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--fg);font:inherit;font-size:14px}
.admin-form button{padding:5px 12px;border:1px solid var(--line);border-radius:4px;background:transparent;color:var(--link);font:inherit;font-size:14px;cursor:pointer}
.admin-filters{display:flex;gap:14px;margin:0 0 14px;font-size:14px}
/* 浏览页筛选表单 */
.filters{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin:0 0 20px}
.filters label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted)}
.filters input,.filters select{padding:6px 8px;border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--fg);font:inherit;font-size:14px}
.filters input[type=text]{min-width:180px}
.filters button{padding:7px 16px;border:1px solid var(--line);border-radius:4px;background:transparent;color:var(--link);font:inherit;font-size:14px;cursor:pointer}
.filters .check{flex-direction:row;align-items:center;gap:6px;color:var(--fg);font-size:14px}
/* 阅读偏好条：一组普通链接，不需要表单，也就不需要放开 form-action */
.prefs{margin:18px 0 0;padding-top:14px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
.prefs .row{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;margin:0 0 6px}
.prefs .row>span:first-child{min-width:4.5em}
.prefs a,.prefs strong{padding:1px 8px;border:1px solid var(--line);border-radius:10px;font-weight:400}
.prefs strong{background:var(--line);color:var(--fg)}
/* 底部转化入口 */
.cta{margin:32px 0 0;padding:16px 18px;border:1px solid var(--line);border-radius:8px;background:rgba(127,127,127,.06)}
.cta h2{margin:0 0 6px;font-size:1.05em}.cta p{margin:0 0 8px}
.cta .acts{display:flex;flex-wrap:wrap;gap:10px 18px}
footer.site{border-top:1px solid var(--line);margin-top:32px}
footer.site .bar{max-width:var(--w);margin:0 auto;padding:18px 20px 40px;display:flex;flex-wrap:wrap;gap:6px 16px;justify-content:space-between;font-size:14px;color:var(--muted)}
@media (max-width:560px){.profile img{width:56px;height:56px}h1{font-size:1.4em}}
`;

export interface OpenGraph {
  /** book / profile。缺省 website。 */
  type?: string;
  /** 绝对地址；PUBLIC_BASE_URL 未配置时留空，此时连同 og:image 一起省略。 */
  url?: string | null;
  image?: string | null;
  /** 大图卡片（1200×630 封面）为 true，方图头像为 false。 */
  imageWide?: boolean;
}

export interface FeedLink {
  href: string;
  title: string;
}

export interface LayoutProps {
  title: string;
  description?: string;
  og?: OpenGraph;
  /** 规范地址；带偏好参数的页面靠它收敛到同一个 URL。 */
  canonical?: string | null;
  /** 上一页 / 下一页，供爬虫理解分页序列。 */
  prev?: string | null;
  next?: string | null;
  /** 已序列化的 JSON-LD（必须过 `jsonLd()` 转义）。 */
  jsonLd?: string | null;
  feed?: FeedLink | null;
  prefs?: ReadPrefs;
  /** 底部转化入口；管理页等内部页面可以关掉。 */
  cta?: boolean;
}

/** 站点底部的转化入口（§3.5：页面此前没有任何 CTA）。 */
export const SiteCta: FC<{ heading?: string; lead?: string }> = ({ heading, lead }) => (
  <aside class="cta" aria-labelledby="cta-title">
    <h2 id="cta-title">{heading ?? '喜欢这个故事？'}</h2>
    <p>{lead ?? '注册账号可以点赞、留言、收藏；装上桌面端还能把它二创成你自己的版本。'}</p>
    <div class="acts">
      <a href="/download">下载桌面端 ›</a>
      <a href="/download#register">注册账号 ›</a>
      <a href="/browse">继续逛逛 ›</a>
    </div>
  </aside>
);

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({
  title,
  description,
  og,
  canonical,
  prev,
  next,
  jsonLd,
  feed,
  prefs,
  cta = true,
  children,
}) => (
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title ? `${title} · The-Water 公共区` : 'The-Water 公共区'}</title>
      {description ? <meta name="description" content={description.slice(0, 200)} /> : null}
      {canonical ? <link rel="canonical" href={canonical} /> : null}
      {prev ? <link rel="prev" href={prev} /> : null}
      {next ? <link rel="next" href={next} /> : null}
      {feed ? <link rel="alternate" type="application/rss+xml" title={feed.title} href={feed.href} /> : null}
      <meta property="og:site_name" content="The-Water 公共区" />
      <meta property="og:title" content={title || 'The-Water 公共区'} />
      {description ? <meta property="og:description" content={description.slice(0, 200)} /> : null}
      <meta property="og:type" content={og?.type ?? 'website'} />
      {og?.url ? <meta property="og:url" content={og.url} /> : null}
      {og?.image ? <meta property="og:image" content={og.image} /> : null}
      <meta name="twitter:card" content={og?.image && og.imageWide !== false ? 'summary_large_image' : 'summary'} />
      {/* CSS 与 JSON-LD 都是已转义的字符串：hono/jsx 会把文本子节点里的 > & " 转成实体，
          直接放会破坏样式选择器与 JSON，所以这里走 dangerouslySetInnerHTML。
          JSON-LD 的内容必须先经过 seo.ts 的 `jsonLd()`（把 < > & 转成 \u 转义）。 */}
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      {jsonLd ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} /> : null}
    </head>
    <body class={prefsClass(prefs ?? DEFAULT_PREFS)}>
      <a class="skip" href="#main">
        跳到正文
      </a>
      <header class="site">
        <div class="bar">
          <a class="brand" href="/">
            The-Water 公共区
          </a>
          <nav class="site-nav" aria-label="站点导航">
            <a href="/browse">浏览</a>
            <a href="/browse?sort=popular">热门</a>
            <a href="/tags">标签</a>
            <a href="/download">下载桌面端</a>
          </nav>
        </div>
      </header>
      <main id="main">
        {children}
        {cta ? <SiteCta /> : null}
      </main>
      <footer class="site">
        <div class="bar">
          <span>The-Water · 读一本书，写一个故事</span>
          <span>
            <a href="/feed.xml">RSS</a> · <a href="/sitemap.xml">站点地图</a>
          </span>
        </div>
      </footer>
    </body>
  </html>
);
