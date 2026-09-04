import { Hono, type Context } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { eq } from 'drizzle-orm';
import { avatarSvg, hueFromSeed, LICENSE_LABELS, type License } from '@the-water/shared';
import type { AppDeps, AppEnv, AuthUser } from '../context';
import { toAuthUser } from '../context';
import { comments, sessions, users } from '../db/schema';
import { forbidden, notFound, unauthorized, validation } from '../lib/errors';
import { hashToken, isTokenShape } from '../lib/tokens';
import { authorShareUrl, novelShareUrl } from '../lib/urls';
import { keyByIp, rateLimit } from '../middleware/rate-limit';
import { parseIndex } from '../modules/browse/routes';
import { getChapter, listChapters } from '../modules/browse/service';
import { findNovelRow, getNovelDetail } from '../modules/novels/service';
import { getUserProfileByHandle, findUserByHandle } from '../modules/users/service';
import { recordView } from '../modules/social/service';
import { listModerationEvents } from '../modules/admin/audit';
import * as admin from '../modules/admin/service';
import { novelCoverPng, novelCoverSvg, rasterizePng } from './cover';
import {
  AdminPage,
  AuthorPage,
  BrowsePage,
  ChapterPage,
  DownloadPage,
  HomePage,
  NovelPage,
  TagsPage,
  type AdminReportView,
} from './pages';
import { prefsCookieValue, resolvePrefs, type ReadPrefs } from './prefs';
import {
  allTags,
  authorNovelsPage,
  browseNovelsPage,
  popularTags,
  recentlyUpdated,
  WEB_SORTS,
  type WebBrowseFilter,
  type WebSort,
} from './query';
import {
  authorsSitemapXml,
  chaptersSitemapXml,
  novelFeedXml,
  novelsSitemapXml,
  robotsTxt,
  sitemapIndexXml,
  siteFeedXml,
} from './seo';

/** 列表每页条数。首页 / 浏览页 / 作者页 20 本，章节目录 100 章（数据模型上限 500 章 → 5 页）。 */
export const NOVELS_PER_PAGE = 20;
export const CHAPTERS_PER_PAGE = 100;
const HOT_ON_HOME = 5;
const TAGS_ON_HOME = 12;
const FEED_ITEMS = 30;

/**
 * 网页路由没有会话 cookie，管理页因此要求把会话 token 显式带上：
 * 读页面用 `/admin?token=<token>`（或 Authorization 头），动作用表单里的隐藏字段。
 * 代价是 token 会出现在地址栏与访问日志里，仅供内网 / 少量管理员应急使用；
 * 正式后台应走桌面端或带 cookie 的管理前端。
 */
async function requireWebAdmin(deps: AppDeps, token: string | undefined): Promise<AuthUser> {
  if (!token || !isTokenShape(token)) throw unauthorized('请在地址后带上 ?token=<管理员会话 token>');
  const row = deps.db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, await hashToken(token)))
    .get();
  if (!row) throw unauthorized('登录凭证无效');
  if (row.session.expiresAt.getTime() <= deps.clock.now().getTime()) throw unauthorized('登录已过期');
  if (row.user.deletedAt !== null) throw unauthorized('账号已注销');
  if (row.user.role !== 'admin') throw forbidden('需要管理员权限');
  return toAuthUser(row.user);
}

function bearerOf(header: string | undefined): string | undefined {
  const m = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return m ? m[1] : undefined;
}

/** 表单字段一律当字符串取，空串按未填处理。 */
function field(body: Record<string, unknown>, name: string): string | undefined {
  const v = body[name];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** 只允许跳回本站的管理页，避免变成开放重定向。 */
function safeBack(raw: string | undefined, token: string): string {
  return raw && raw.startsWith('/admin?') ? raw : `/admin?token=${encodeURIComponent(token)}`;
}

/**
 * 站点绝对地址。配置了 PUBLIC_BASE_URL 就用它（部署在反代后面时唯一可信的来源），
 * 否则按当前请求推导 —— sitemap / RSS / canonical 都必须是绝对地址，不能因为漏配就整块失效。
 * og:* 仍然只在配置了 PUBLIC_BASE_URL 时输出，保持既有行为。
 */
function siteBase(deps: AppDeps, c: Context<AppEnv>): string {
  const configured = deps.env.publicBaseUrl.replace(/\/+$/, '');
  if (configured) return configured;
  try {
    return new URL(c.req.url).origin;
  } catch {
    return '';
  }
}

/** 桌面端下载地址。env.ts 归属另一位 agent，这里做前向兼容读取（见报告中的 env 建议）。 */
function downloadUrl(deps: AppDeps): string {
  const v = (deps.env as { downloadUrl?: unknown }).downloadUrl;
  return typeof v === 'string' ? v : '';
}

/** Hono 的 c.body 不吃 Uint8Array，转成独立的 ArrayBuffer 再交给它。 */
function bytes(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/** 拼查询串，值为空的项直接省略。 */
function qs(params: Record<string, string | number | undefined | null>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

function parsePage(raw: string | undefined): number {
  const n = Number(raw ?? '1');
  return Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : 1;
}

const LICENSES = Object.keys(LICENSE_LABELS) as License[];

function parseBrowseFilter(q: Record<string, string>): WebBrowseFilter {
  const trim = (v: string | undefined, max: number) => {
    const s = (v ?? '').trim();
    return s ? s.slice(0, max) : undefined;
  };
  return {
    sort: (WEB_SORTS.find((s) => s === q.sort) ?? 'latest') as WebSort,
    q: trim(q.q, 50),
    tag: trim(q.tag, 20),
    license: LICENSES.find((l) => l === q.license),
    writingStatus: q.status === 'ongoing' || q.status === 'completed' ? q.status : undefined,
    originalsOnly: q.originals === '1' ? true : undefined,
  };
}

function browseQs(f: WebBrowseFilter, page?: number): string {
  return qs({
    q: f.q,
    tag: f.tag,
    sort: f.sort === 'latest' ? undefined : f.sort,
    status: f.writingStatus,
    license: f.license,
    originals: f.originalsOnly ? '1' : undefined,
    page: page && page > 1 ? page : undefined,
  });
}

/** 仅三个只读网页路由：首页、详情、正文。零客户端 JS，严格 CSP。 */
export function webRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const headersFor = (formAction: string) =>
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        styleSrc: ["'unsafe-inline'"],
        imgSrc: ["'self'"],
        baseUri: ["'none'"],
        formAction: [formAction],
        frameAncestors: ["'none'"],
      },
      referrerPolicy: 'no-referrer',
    });
  // 阅读页零表单（连阅读偏好都是链接），管理页与浏览页的筛选表单要 POST/GET 回本站，
  // 因此只有 /admin 与 /browse 放开 form-action。
  const readerHeaders = headersFor("'none'");
  const formHeaders = headersFor("'self'");
  const NEEDS_FORM_ACTION = /^\/(admin|browse)(\/|$)/;
  r.use('*', async (c, next) => (NEEDS_FORM_ACTION.test(c.req.path) ? formHeaders(c, next) : readerHeaders(c, next)));
  // 网页路由整体挂读限流（§3.3：此前只有 api 子应用有限流）。
  r.use('*', rateLimit(deps, 'web', keyByIp));

  /**
   * 阅读偏好：query 优先、Cookie 兜底。命中 query 时顺手把 Cookie 写回去，
   * 于是换页、换书都还在。响应加 `Vary: Cookie`，避免共享缓存串味。
   */
  function prefsOf(c: Context<AppEnv>): ReadPrefs {
    const { prefs, fromQuery } = resolvePrefs(c.req.query(), c.req.header('cookie'));
    if (fromQuery) c.header('Set-Cookie', prefsCookieValue(prefs));
    c.header('Vary', 'Cookie');
    return prefs;
  }

  // ---- 首页 / 浏览 / 标签 / 下载 ----

  r.get('/', (c) => {
    const prefs = prefsOf(c);
    const base = siteBase(deps, c);
    const page = parsePage(c.req.query('page'));
    const list = browseNovelsPage(deps, { sort: 'latest' }, page, NOVELS_PER_PAGE);
    const href = (p: number) => `/${qs({ page: p > 1 ? p : undefined })}`;
    return c.html(
      <HomePage
        page={list}
        hot={list.page === 1 ? browseNovelsPage(deps, { sort: 'popular' }, 1, HOT_ON_HOME).items : []}
        tags={popularTags(deps, TAGS_ON_HOME)}
        href={href}
        canonical={base ? `${base}${href(list.page)}` : null}
        prefs={prefs}
      />,
    );
  });

  r.get('/browse', (c) => {
    const prefs = prefsOf(c);
    const base = siteBase(deps, c);
    const f = parseBrowseFilter(c.req.query());
    const page = parsePage(c.req.query('page'));
    const list = browseNovelsPage(deps, f, page, NOVELS_PER_PAGE);
    const href = (p: number) => `/browse${browseQs(f, p)}`;
    return c.html(
      <BrowsePage
        view={{ filter: f, page: list, tags: popularTags(deps, TAGS_ON_HOME), href }}
        canonical={base ? `${base}${href(list.page)}` : null}
        prefs={prefs}
      />,
    );
  });

  r.get('/tags', (c) => {
    const prefs = prefsOf(c);
    const base = siteBase(deps, c);
    return c.html(<TagsPage tags={allTags(deps, 500)} canonical={base ? `${base}/tags` : null} prefs={prefs} />);
  });

  r.get('/download', (c) => {
    const prefs = prefsOf(c);
    const base = siteBase(deps, c);
    return c.html(<DownloadPage downloadUrl={downloadUrl(deps)} canonical={base ? `${base}/download` : null} prefs={prefs} />);
  });

  // ---- SEO：robots / sitemap / RSS ----

  r.get('/robots.txt', (c) => {
    c.header('Content-Type', 'text/plain; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=3600');
    return c.body(robotsTxt(siteBase(deps, c)));
  });

  const xmlResponse = (c: Context<AppEnv>, body: string, contentType = 'application/xml; charset=utf-8') => {
    c.header('Content-Type', contentType);
    c.header('Cache-Control', 'public, max-age=1800');
    return c.body(body);
  };

  // Hono 的参数只能占满整个路径段（`/sitemap-novels-:p.xml` 这种带前后缀的写法匹配不上），
  // 所以整段用正则匹配，分片序号再从文件名里取。
  const shardNo = (file: string) => parsePage(/-(\d+)\.xml$/.exec(file)?.[1]);
  r.get('/sitemap.xml', (c) => xmlResponse(c, sitemapIndexXml(deps, siteBase(deps, c))));
  r.get('/:file{sitemap-novels-[0-9]+\\.xml}', (c) => xmlResponse(c, novelsSitemapXml(deps, siteBase(deps, c), shardNo(c.req.param('file')))));
  r.get('/:file{sitemap-chapters-[0-9]+\\.xml}', (c) => xmlResponse(c, chaptersSitemapXml(deps, siteBase(deps, c), shardNo(c.req.param('file')))));
  r.get('/:file{sitemap-authors-[0-9]+\\.xml}', (c) => xmlResponse(c, authorsSitemapXml(deps, siteBase(deps, c), shardNo(c.req.param('file')))));

  r.get('/feed.xml', (c) =>
    xmlResponse(c, siteFeedXml(siteBase(deps, c), recentlyUpdated(deps, FEED_ITEMS), deps.clock.now()), 'application/rss+xml; charset=utf-8'),
  );

  r.get('/n/:id/feed.xml', (c) => {
    const id = c.req.param('id');
    const novel = getNovelDetail(deps, id, null);
    const { items } = listChapters(deps, id, 'current', null, 0, 500);
    const recent = items.slice(-FEED_ITEMS).reverse();
    const body = novelFeedXml(
      siteBase(deps, c),
      {
        id: novel.id,
        title: novel.title,
        summary: novel.summary,
        authorName: novel.author.displayName,
        lastPublishedAt: novel.lastPublishedAt,
      },
      recent,
      deps.clock.now(),
    );
    return xmlResponse(c, body, 'application/rss+xml; charset=utf-8');
  });

  // ---- 作品详情 ----

  r.get('/n/:id', (c) => {
    const prefs = prefsOf(c);
    const base = siteBase(deps, c);
    const id = c.req.param('id');
    // 网页匿名访客不带登录态，仅展示公开内容。
    const novel = getNovelDetail(deps, id, null);
    const page = parsePage(c.req.query('p'));
    const probe = listChapters(deps, id, 'current', null, 0, 1);
    const pageCount = Math.max(1, Math.ceil(probe.total / CHAPTERS_PER_PAGE));
    const p = Math.min(page, pageCount);
    const { items } = listChapters(deps, id, 'current', null, (p - 1) * CHAPTERS_PER_PAGE, CHAPTERS_PER_PAGE);
    const url = novelShareUrl(deps.env, id);
    const tocHref = (n: number) => `/n/${id}${qs({ p: n > 1 ? n : undefined })}`;
    return c.html(
      <NovelPage
        novel={novel}
        chapters={items}
        tocPage={p}
        tocPageCount={pageCount}
        tocHref={tocHref}
        totalChapters={probe.total}
        og={{ url, image: url ? `${url}/cover.png` : null }}
        base={base}
        canonical={base ? `${base}${tocHref(p)}` : null}
        feed={{ href: `/n/${id}/feed.xml`, title: `${novel.title} · 更新` }}
        prefs={prefs}
      />,
    );
  });

  /** 分享卡片图。SVG 由同源提供，CSP 的 img-src 'self' 允许它。 */
  r.get('/n/:id/cover.svg', (c) => {
    const novel = getNovelDetail(deps, c.req.param('id'), null);
    const svg = novelCoverSvg(coverOpts(novel));
    c.header('Content-Type', 'image/svg+xml; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=3600');
    return c.body(svg);
  });

  /** PNG 版分享卡片：微信 / 推特的抓取器不渲染 SVG，og:image 用的是这一张。 */
  r.get('/n/:id/cover.png', async (c) => {
    const novel = getNovelDetail(deps, c.req.param('id'), null);
    const png = await novelCoverPng(coverOpts(novel));
    c.header('Content-Type', 'image/png');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(bytes(png));
  });

  // ---- 作者主页 ----

  r.get('/u/:handle', (c) => {
    const prefs = prefsOf(c);
    const base = siteBase(deps, c);
    const handle = c.req.param('handle');
    const user = getUserProfileByHandle(deps, handle, null);
    const kindRaw = c.req.query('kind');
    const kind = kindRaw === 'original' || kindRaw === 'derivative' ? kindRaw : 'all';
    const page = parsePage(c.req.query('page'));
    const list = authorNovelsPage(deps, user.id, kind, page, NOVELS_PER_PAGE);
    const href = (p: number) => `/u/${encodeURIComponent(handle)}${qs({ kind: kind === 'all' ? undefined : kind, page: p > 1 ? p : undefined })}`;
    const kindHref = (k: 'all' | 'original' | 'derivative') => `/u/${encodeURIComponent(handle)}${qs({ kind: k === 'all' ? undefined : k })}`;
    const url = authorShareUrl(deps.env, user.handle);
    return c.html(
      <AuthorPage
        user={user}
        page={list}
        kind={kind}
        href={href}
        kindHref={kindHref}
        og={{ url, image: url ? `${url}/avatar.png` : null }}
        base={base}
        canonical={base ? `${base}${href(list.page)}` : null}
        prefs={prefs}
      />,
    );
  });

  r.get('/u/:handle/avatar.svg', (c) => {
    const user = findUserByHandle(deps, c.req.param('handle'));
    if (!user) throw notFound('用户');
    c.header('Content-Type', 'image/svg+xml; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(avatarSvg(user.id, 96));
  });

  r.get('/u/:handle/avatar.png', async (c) => {
    const user = findUserByHandle(deps, c.req.param('handle'));
    if (!user) throw notFound('用户');
    const png = await rasterizePng(avatarSvg(user.id, 512), { width: 512, hue: hueFromSeed(user.id) });
    c.header('Content-Type', 'image/png');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(bytes(png));
  });

  // ---- 审核后台（P0-6）----

  r.get('/admin', async (c) => {
    const q = c.req.query();
    const token = q.token ?? bearerOf(c.req.header('authorization'));
    const user = await requireWebAdmin(deps, token);
    const reportStatus = (['open', 'resolved', 'dismissed'] as const).find((s) => s === q.reportStatus) ?? 'open';
    const userStatus = (['active', 'suspended', 'banned'] as const).find((s) => s === q.userStatus);
    const reports = admin.listReports(deps, reportStatus, q.reportCursor, 20);
    const userPage = admin.listUsers(deps, { q: q.q, status: userStatus, cursor: q.userCursor, limit: 20 });
    const events = listModerationEvents(deps, {}, undefined, 30);
    const views: AdminReportView[] = reports.items.map((report) => {
      const novel = findNovelRow(deps, report.novelId);
      const comment = report.commentId
        ? deps.db.select().from(comments).where(eq(comments.id, report.commentId)).get()
        : undefined;
      return {
        report,
        novelTitle: novel?.title ?? '（已删除）',
        novelModerationStatus: novel?.moderationStatus ?? 'removed',
        commentBody: comment && comment.status === 'ok' ? comment.body : null,
        commentStatus: comment?.status ?? null,
      };
    });
    const token1 = token!;
    const back = `/admin?token=${encodeURIComponent(token1)}&reportStatus=${reportStatus}${q.q ? `&q=${encodeURIComponent(q.q)}` : ''}${
      userStatus ? `&userStatus=${userStatus}` : ''
    }`;
    return c.html(
      <AdminPage
        data={{
          token: token1,
          back,
          adminName: `${user.displayName} @${user.handle}`,
          reports: views,
          reportsNextCursor: reports.nextCursor,
          reportStatus,
          users: userPage.items,
          usersNextCursor: userPage.nextCursor,
          q: q.q ?? '',
          userStatus: userStatus ?? '',
          events: events.items,
        }}
      />,
    );
  });

  /** 表单动作：处理完统一 303 跳回管理页，零 JS 下也不会重复提交。 */
  const action = (path: string, run: (user: AuthUser, body: Record<string, unknown>, id: string) => void) =>
    r.post(path, async (c) => {
      const body = (await c.req.parseBody()) as Record<string, unknown>;
      const token = field(body, 'token') ?? bearerOf(c.req.header('authorization'));
      const user = await requireWebAdmin(deps, token);
      const id = field(body, 'id');
      if (!id) throw validation('缺少目标 id');
      run(user, body, id);
      return c.redirect(safeBack(field(body, 'back'), token!), 303);
    });

  action('/admin/actions/report', (user, body, id) => {
    const status = field(body, 'status') === 'dismissed' ? 'dismissed' : 'resolved';
    admin.resolveReport(deps, user, id, status, field(body, 'note'));
  });

  action('/admin/actions/novel', (user, body, id) => {
    const raw = field(body, 'moderationStatus');
    const status = raw === 'hidden' || raw === 'removed' || raw === 'ok' ? raw : null;
    if (!status) throw validation('处置状态无效');
    admin.setModeration(deps, user, id, status, field(body, 'note'));
  });

  action('/admin/actions/comment', (user, body, id) => {
    admin.setCommentModerationById(deps, user, id, field(body, 'action') === 'restore' ? 'ok' : 'hidden', field(body, 'note'));
  });

  action('/admin/actions/ban', (user, body, id) => {
    const reason = field(body, 'reason');
    if (!reason) throw validation('封禁理由必填');
    const days = Number(field(body, 'days') ?? '');
    const until = Number.isFinite(days) && days > 0 ? new Date(deps.clock.now().getTime() + days * 86_400_000).toISOString() : undefined;
    admin.banUser(deps, user, id, reason, until);
  });

  action('/admin/actions/unban', (user, body, id) => {
    admin.unbanUser(deps, user, id, field(body, 'note'));
  });

  // ---- 章节正文 ----

  r.get('/n/:id/c/:index', (c) => {
    const prefs = prefsOf(c);
    const base = siteBase(deps, c);
    const id = c.req.param('id');
    const index = parseIndex(c.req.param('index'));
    const novel = getNovelDetail(deps, id, null);
    const chapter = getChapter(deps, id, 'current', index, null);
    try {
      recordView(deps, id, `web:${c.get('viewerKey')}`, null);
    } catch {
      /* 计数失败不影响阅读 */
    }
    const share = novelShareUrl(deps.env, id);
    return c.html(
      <ChapterPage
        novel={novel}
        chapter={chapter}
        base={base}
        og={{ url: share ? `${share}/c/${index}` : null, image: share ? `${share}/cover.png` : null }}
        canonical={base ? `${base}/n/${id}/c/${index}` : null}
        prefs={prefs}
      />,
    );
  });

  return r;
}

/** 封面卡片的文案，SVG 与 PNG 共用一套，保证两张图内容一致。 */
function coverOpts(novel: {
  title: string;
  summary: string;
  chapterCount: number;
  charCount: number;
  writingStatus: 'ongoing' | 'completed';
  author: { displayName: string; handle: string };
}) {
  return {
    title: novel.title,
    authorName: `${novel.author.displayName} @${novel.author.handle}`,
    summary: novel.summary,
    stats: `${novel.chapterCount} 章 · ${novel.charCount} 字 · ${novel.writingStatus === 'completed' ? '已完结' : '连载中'}`,
  };
}
