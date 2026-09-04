import type { FC, PropsWithChildren } from 'hono/jsx';

const CSS = `
:root{color-scheme:light dark;--fg:#222;--bg:#fbfaf7;--muted:#777;--line:#e5e2dc;--link:#2a5d9f}
@media (prefers-color-scheme:dark){:root{--fg:#e8e6e1;--bg:#1a1917;--muted:#999;--line:#333;--link:#8ab4f8}}
*{box-sizing:border-box}body{margin:0;font:16px/1.8 -apple-system,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:760px;margin:0 auto;padding:24px 20px 64px}a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
header.site{border-bottom:1px solid var(--line)}header.site div{max-width:760px;margin:0 auto;padding:12px 20px;display:flex;justify-content:space-between;align-items:baseline}
header.site .brand{font-weight:600;color:var(--fg)}.muted{color:var(--muted);font-size:14px}
.profile{display:flex;gap:16px;align-items:center;margin:8px 0 4px}.profile img{width:72px;height:72px;border-radius:50%}
.stats{display:flex;flex-wrap:wrap;gap:14px;margin:10px 0 20px;font-size:14px;color:var(--muted)}
.badges span{display:inline-block;margin:0 6px 6px 0;padding:1px 9px;border:1px solid var(--line);border-radius:10px;font-size:12px}
ul.list{list-style:none;padding:0;margin:0}ul.list li{padding:14px 0;border-bottom:1px solid var(--line)}
ul.list h3{margin:0 0 4px;font-size:18px}.tags span{display:inline-block;margin-right:6px;padding:0 8px;border:1px solid var(--line);border-radius:10px;font-size:12px}
ol.toc{padding-left:2em;columns:2;column-gap:32px}ol.toc li{break-inside:avoid}
article.chapter p{text-indent:2em;margin:0 0 1em}nav.pager{display:flex;justify-content:space-between;margin:32px 0 0;padding-top:16px;border-top:1px solid var(--line)}
h1{font-size:26px;margin:8px 0}h2{font-size:20px;margin:28px 0 12px}.origin{padding:10px 14px;border-left:3px solid var(--link);background:rgba(42,93,159,.06);margin:16px 0}
.card{border:1px solid var(--line);border-radius:6px;padding:12px 14px;margin:0 0 14px}
.admin-form{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0 0}
.admin-form input,.admin-form select{flex:1 1 160px;min-width:0;padding:5px 8px;border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--fg);font:inherit;font-size:14px}
.admin-form button{padding:5px 12px;border:1px solid var(--line);border-radius:4px;background:transparent;color:var(--link);font:inherit;font-size:14px;cursor:pointer}
.admin-filters{display:flex;gap:14px;margin:0 0 14px;font-size:14px}
`;

export interface OpenGraph {
  /** book / profile。缺省 website。 */
  type?: string;
  /** 绝对地址；PUBLIC_BASE_URL 未配置时留空，此时连同 og:image 一起省略。 */
  url?: string | null;
  image?: string | null;
}

export const Layout: FC<PropsWithChildren<{ title: string; description?: string; og?: OpenGraph }>> = ({ title, description, og, children }) => (
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title ? `${title} · The-Water 公共区` : 'The-Water 公共区'}</title>
      {description ? <meta name="description" content={description.slice(0, 200)} /> : null}
      <meta property="og:site_name" content="The-Water 公共区" />
      <meta property="og:title" content={title || 'The-Water 公共区'} />
      {description ? <meta property="og:description" content={description.slice(0, 200)} /> : null}
      <meta property="og:type" content={og?.type ?? 'website'} />
      {og?.url ? <meta property="og:url" content={og.url} /> : null}
      {og?.image ? <meta property="og:image" content={og.image} /> : null}
      <meta name="twitter:card" content={og?.image ? 'summary_large_image' : 'summary'} />
      <style>{CSS}</style>
    </head>
    <body>
      <header class="site">
        <div>
          <a class="brand" href="/">The-Water 公共区</a>
          <span class="muted">阅读 · 二创 · 溯源</span>
        </div>
      </header>
      <main>{children}</main>
    </body>
  </html>
);
