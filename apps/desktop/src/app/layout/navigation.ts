/**
 * 侧栏导航的路由匹配 —— 纯函数，可单测。
 *
 * 原来是 `q.includes('tab=novels')` 这样的字符串包含判断：`?tab=novelsx`、
 * `?other=tab=novels` 都会误命中，`/studio` 与 `/studioX` 也分不开。
 * 这里改成用 react-router 的 `matchPath` 按路径段匹配，查询参数用 `URLSearchParams` 解析。
 */
import { matchPath } from 'react-router';

export type NavKey = 'library' | 'studio' | 'public' | 'notifications' | 'chat' | 'settings';

/** 书架页的两个 tab：`?tab=novels` 归到「我的故事」，其余归「书架」。 */
export type LibraryTab = 'documents' | 'novels';

export function libraryTabOf(search: string): LibraryTab {
  return new URLSearchParams(search).get('tab') === 'novels' ? 'novels' : 'documents';
}

/** 判断当前位置属于哪一项导航；都不属于（比如 404）返回 null。 */
export function activeNavKey(pathname: string, search: string): NavKey | null {
  if (matchPath('/library', pathname)) return libraryTabOf(search) === 'novels' ? 'studio' : 'library';
  if (matchPath({ path: '/studio', end: false }, pathname)) return 'studio';
  // 通知页挂在 /public 下，但侧栏是独立一项，先于「公共书房」判断。
  if (matchPath('/public/notifications', pathname)) return 'notifications';
  if (matchPath({ path: '/public', end: false }, pathname)) return 'public';
  if (matchPath({ path: '/chat', end: false }, pathname)) return 'chat';
  if (matchPath({ path: '/settings', end: false }, pathname)) return 'settings';
  return null;
}

/** 阅读器是沉浸式页面，进去要把侧栏收起来。 */
export function isImmersiveRoute(pathname: string): boolean {
  return matchPath('/reader/:documentId', pathname) !== null;
}
