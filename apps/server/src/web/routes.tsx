import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { avatarSvg } from '@the-water/shared';
import type { AppDeps, AppEnv } from '../context';
import { notFound } from '../lib/errors';
import { authorShareUrl, novelShareUrl } from '../lib/urls';
import { parseIndex } from '../modules/browse/routes';
import { getChapter, latestNovels, listChapters } from '../modules/browse/service';
import { getNovelDetail } from '../modules/novels/service';
import { getUserProfileByHandle, listUserNovels, findUserByHandle } from '../modules/users/service';
import { recordView } from '../modules/social/service';
import { novelCoverSvg } from './cover';
import { AuthorPage, ChapterPage, HomePage, NovelPage } from './pages';

/** 仅三个只读网页路由：首页、详情、正文。零客户端 JS，严格 CSP。 */
export function webRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  r.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        styleSrc: ["'unsafe-inline'"],
        imgSrc: ["'self'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
      },
      referrerPolicy: 'no-referrer',
    }),
  );

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
