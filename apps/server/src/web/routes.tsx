import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { eq } from 'drizzle-orm';
import { avatarSvg } from '@the-water/shared';
import type { AppDeps, AppEnv, AuthUser } from '../context';
import { toAuthUser } from '../context';
import { comments, sessions, users } from '../db/schema';
import { forbidden, notFound, unauthorized, validation } from '../lib/errors';
import { hashToken, isTokenShape } from '../lib/tokens';
import { authorShareUrl, novelShareUrl } from '../lib/urls';
import { keyByIp, rateLimit } from '../middleware/rate-limit';
import { parseIndex } from '../modules/browse/routes';
import { getChapter, latestNovels, listChapters } from '../modules/browse/service';
import { findNovelRow, getNovelDetail } from '../modules/novels/service';
import { getUserProfileByHandle, listUserNovels, findUserByHandle } from '../modules/users/service';
import { recordView } from '../modules/social/service';
import { listModerationEvents } from '../modules/admin/audit';
import * as admin from '../modules/admin/service';
import { novelCoverSvg } from './cover';
import { AdminPage, AuthorPage, ChapterPage, HomePage, NovelPage, type AdminReportView } from './pages';

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
  // 阅读页零表单，管理页要 POST 回本站，因此只有 /admin 放开 form-action。
  const readerHeaders = headersFor("'none'");
  const adminHeaders = headersFor("'self'");
  r.use('*', async (c, next) => (c.req.path.startsWith('/admin') ? adminHeaders(c, next) : readerHeaders(c, next)));
  // 网页路由整体挂读限流（§3.3：此前只有 api 子应用有限流）。
  r.use('*', rateLimit(deps, 'web', keyByIp));

  r.get('/', (c) => c.html(<HomePage items={latestNovels(deps, 20)} />));

  r.get('/n/:id', (c) => {
    const id = c.req.param('id');
    // 网页匿名访客不带登录态，仅展示公开内容。
    const novel = getNovelDetail(deps, id, null);
    const { items } = listChapters(deps, id, 'current', null, 0, 200);
    const url = novelShareUrl(deps.env, id);
    return c.html(<NovelPage novel={novel} chapters={items} og={{ url, image: url ? `${url}/cover.svg` : null }} />);
  });

  /** 分享卡片图。SVG 由同源提供，CSP 的 img-src 'self' 允许它。 */
  r.get('/n/:id/cover.svg', (c) => {
    const novel = getNovelDetail(deps, c.req.param('id'), null);
    const svg = novelCoverSvg({
      title: novel.title,
      authorName: `${novel.author.displayName} @${novel.author.handle}`,
      summary: novel.summary,
      stats: `${novel.chapterCount} 章 · ${novel.charCount} 字 · ${novel.writingStatus === 'completed' ? '已完结' : '连载中'}`,
    });
    c.header('Content-Type', 'image/svg+xml; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=3600');
    return c.body(svg);
  });

  r.get('/u/:handle', (c) => {
    const user = getUserProfileByHandle(deps, c.req.param('handle'), null);
    const { items } = listUserNovels(deps, user.id, null, { kind: 'all', limit: 50 });
    const url = authorShareUrl(deps.env, user.handle);
    return c.html(<AuthorPage user={user} novels={items} og={{ url, image: url ? `${url}/avatar.svg` : null }} />);
  });

  r.get('/u/:handle/avatar.svg', (c) => {
    const user = findUserByHandle(deps, c.req.param('handle'));
    if (!user) throw notFound('用户');
    c.header('Content-Type', 'image/svg+xml; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(avatarSvg(user.id, 96));
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

  r.get('/n/:id/c/:index', (c) => {
    const id = c.req.param('id');
    const index = parseIndex(c.req.param('index'));
    const novel = getNovelDetail(deps, id, null);
    const chapter = getChapter(deps, id, 'current', index, null);
    try {
      recordView(deps, id, `web:${c.get('viewerKey')}`, null);
    } catch {
      /* 计数失败不影响阅读 */
    }
    return c.html(<ChapterPage novel={novel} chapter={chapter} />);
  });

  return r;
}
