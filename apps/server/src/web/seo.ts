/**
 * SEO 基础设施：robots.txt、分片站点地图、RSS、JSON-LD。
 *
 * 站点地图的分片策略：
 * - `/sitemap.xml` 是 sitemapindex，只列分片，本身不含 URL；
 * - 作品页 `/sitemap-novels-{p}.xml`、作者页 `/sitemap-authors-{p}.xml` 各 1000 条一片；
 * - 章节页数量最大（一本最多 500 章），按**全局章节序号**切片
 *   `/sitemap-chapters-{p}.xml`，每片 10000 条，用窗口函数定位分片覆盖哪些作品，
 *   不需要把全部作品拉进内存。
 * 三者都远低于 sitemap 协议的 50000 条 / 50MB 上限。
 */
import type { NovelSummary } from '@the-water/shared';
import type { AppDeps } from '../context';
import {
  chapterSitemapSlice,
  publicAuthorCount,
  publicChapterTotal,
  publicNovelCount,
  sitemapAuthors,
  sitemapNovels,
} from './query';

export const SITEMAP_NOVELS_PER_PAGE = 1000;
export const SITEMAP_AUTHORS_PER_PAGE = 1000;
export const SITEMAP_CHAPTERS_PER_PAGE = 10_000;

/** XML 文本转义。 */
export function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * JSON-LD 内联时必须把 `<` `>` `&` 转成 \u 转义，
 * 否则作品标题里的 `</script>` 会提前闭合脚本块（存储型 XSS）。
 */
export function jsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/[<>&\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function robotsTxt(base: string): string {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    'Disallow: /admin/',
    // 偏好参数只是同一篇正文的换皮，别让爬虫把它们当独立页面。
    'Disallow: /*?*fs=',
    'Disallow: /*?*lh=',
    'Disallow: /*?*w=',
    'Disallow: /*?*th=',
    '',
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n');
}

const W3C = (d: Date | null) => (d ? d.toISOString() : undefined);

function urlEntry(loc: string, lastmod?: string, changefreq?: string, priority?: string): string {
  return [
    '  <url>',
    `    <loc>${xml(loc)}</loc>`,
    lastmod ? `    <lastmod>${lastmod}</lastmod>` : '',
    changefreq ? `    <changefreq>${changefreq}</changefreq>` : '',
    priority ? `    <priority>${priority}</priority>` : '',
    '  </url>',
  ]
    .filter(Boolean)
    .join('\n');
}

function urlset(entries: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`;
}

export interface SitemapShards {
  novels: number;
  authors: number;
  chapters: number;
}

export function sitemapShardCounts(deps: AppDeps): SitemapShards {
  return {
    novels: Math.ceil(publicNovelCount(deps) / SITEMAP_NOVELS_PER_PAGE),
    authors: Math.ceil(publicAuthorCount(deps) / SITEMAP_AUTHORS_PER_PAGE),
    chapters: Math.ceil(publicChapterTotal(deps) / SITEMAP_CHAPTERS_PER_PAGE),
  };
}

/** sitemapindex：列出全部分片。作品为 0 时也返回合法的空 index。 */
export function sitemapIndexXml(deps: AppDeps, base: string): string {
  const shards = sitemapShardCounts(deps);
  const items: string[] = [];
  const add = (path: string) => items.push(`  <sitemap>\n    <loc>${xml(base + path)}</loc>\n  </sitemap>`);
  for (let p = 1; p <= shards.novels; p++) add(`/sitemap-novels-${p}.xml`);
  for (let p = 1; p <= shards.chapters; p++) add(`/sitemap-chapters-${p}.xml`);
  for (let p = 1; p <= shards.authors; p++) add(`/sitemap-authors-${p}.xml`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items.join('\n')}\n</sitemapindex>\n`;
}

export function novelsSitemapXml(deps: AppDeps, base: string, page: number): string {
  const rows = sitemapNovels(deps, (page - 1) * SITEMAP_NOVELS_PER_PAGE, SITEMAP_NOVELS_PER_PAGE);
  const entries = [
    ...(page === 1
      ? [urlEntry(`${base}/`, undefined, 'hourly', '1.0'), urlEntry(`${base}/browse`, undefined, 'daily', '0.8'), urlEntry(`${base}/tags`, undefined, 'weekly', '0.6')]
      : []),
    ...rows.map((n) => urlEntry(`${base}/n/${encodeURIComponent(n.id)}`, W3C(n.lastPublishedAt), 'weekly', '0.8')),
  ];
  return urlset(entries);
}

export function chaptersSitemapXml(deps: AppDeps, base: string, page: number): string {
  const from = (page - 1) * SITEMAP_CHAPTERS_PER_PAGE;
  const slice = chapterSitemapSlice(deps, from, from + SITEMAP_CHAPTERS_PER_PAGE);
  const entries: string[] = [];
  for (const s of slice) {
    for (let i = s.start; i < s.end; i++) {
      entries.push(urlEntry(`${base}/n/${encodeURIComponent(s.id)}/c/${i}`, W3C(s.lastPublishedAt), 'monthly', '0.6'));
    }
  }
  return urlset(entries);
}

export function authorsSitemapXml(deps: AppDeps, base: string, page: number): string {
  const rows = sitemapAuthors(deps, (page - 1) * SITEMAP_AUTHORS_PER_PAGE, SITEMAP_AUTHORS_PER_PAGE);
  return urlset(rows.map((a) => urlEntry(`${base}/u/${encodeURIComponent(a.handle)}`, W3C(a.updatedAt), 'weekly', '0.5')));
}

// ---- RSS ----

const rfc822 = (d: Date | null, fallback: Date) => (d ?? fallback).toUTCString();

function rssItem(o: { title: string; link: string; guid: string; pubDate: string; description: string }): string {
  return [
    '    <item>',
    `      <title>${xml(o.title)}</title>`,
    `      <link>${xml(o.link)}</link>`,
    `      <guid isPermaLink="false">${xml(o.guid)}</guid>`,
    `      <pubDate>${o.pubDate}</pubDate>`,
    `      <description>${xml(o.description)}</description>`,
    '    </item>',
  ].join('\n');
}

function rssDoc(o: { title: string; link: string; selfLink: string; description: string; items: string[] }): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${xml(o.title)}</title>`,
    `    <link>${xml(o.link)}</link>`,
    `    <atom:link href="${xml(o.selfLink)}" rel="self" type="application/rss+xml"/>`,
    `    <description>${xml(o.description)}</description>`,
    '    <language>zh-CN</language>',
    ...o.items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

/** 全站连载更新源：最近更新的作品各一条。 */
export function siteFeedXml(base: string, items: NovelSummary[], now: Date): string {
  return rssDoc({
    title: 'The-Water 公共区 · 最新更新',
    link: `${base}/`,
    selfLink: `${base}/feed.xml`,
    description: '读一本书，写一个故事。公共区最近更新的作品。',
    items: items.map((n) =>
      rssItem({
        title: `${n.title}（${n.author.displayName}）`,
        link: `${base}/n/${encodeURIComponent(n.id)}`,
        guid: `${n.id}:${n.chapterCount}`,
        pubDate: rfc822(n.lastPublishedAt ? new Date(n.lastPublishedAt) : null, now),
        description: n.summary || `${n.chapterCount} 章 · ${n.charCount} 字`,
      }),
    ),
  });
}

export interface FeedChapter {
  index: number;
  title: string;
  charCount: number;
  hash: string;
}

/** 单本连载源：最近的章节各一条（新章在前）。 */
export function novelFeedXml(
  base: string,
  novel: { id: string; title: string; summary: string; authorName: string; lastPublishedAt: string | null },
  chapters: FeedChapter[],
  now: Date,
): string {
  const link = `${base}/n/${encodeURIComponent(novel.id)}`;
  return rssDoc({
    title: `${novel.title} · 更新`,
    link,
    selfLink: `${link}/feed.xml`,
    description: novel.summary || `${novel.authorName} 的作品《${novel.title}》的章节更新。`,
    items: chapters.map((ch) =>
      rssItem({
        title: ch.title || `第 ${ch.index + 1} 章`,
        link: `${link}/c/${ch.index}`,
        guid: ch.hash,
        pubDate: rfc822(novel.lastPublishedAt ? new Date(novel.lastPublishedAt) : null, now),
        description: `第 ${ch.index + 1} 章 · ${ch.charCount} 字`,
      }),
    ),
  });
}
