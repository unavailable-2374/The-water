/**
 * 阅读偏好（字号 / 行距 / 版心宽度 / 主题）。
 *
 * 网页层是零客户端 JS 的，所以偏好走「链接 + 服务端渲染 class + 功能性 Cookie」：
 * - 偏好条是一组普通 `<a>`，点了就带上 query 参数 —— 不需要表单，
 *   因此阅读页的 CSP 仍然可以保持 `form-action 'none'`、`script-src` 继承 `default-src 'none'`；
 * - 命中 query 时把偏好写进 Cookie（HttpOnly + SameSite=Lax + 一年），换页 / 换书都还在；
 * - 浏览器禁用 Cookie 时，链接里仍然带着当前偏好，本书内翻页照样生效。
 */

export const FONT_SIZES = ['sm', 'md', 'lg', 'xl'] as const;
export const LINE_HEIGHTS = ['tight', 'normal', 'loose'] as const;
export const WIDTHS = ['narrow', 'normal', 'wide'] as const;
export const THEMES = ['auto', 'light', 'sepia', 'dark'] as const;

export type FontSize = (typeof FONT_SIZES)[number];
export type LineHeight = (typeof LINE_HEIGHTS)[number];
export type Width = (typeof WIDTHS)[number];
export type Theme = (typeof THEMES)[number];

export interface ReadPrefs {
  fs: FontSize;
  lh: LineHeight;
  w: Width;
  th: Theme;
}

export const DEFAULT_PREFS: ReadPrefs = { fs: 'md', lh: 'normal', w: 'normal', th: 'auto' };

export const PREFS_COOKIE = 'tw_read';

export const FONT_SIZE_LABELS: Record<FontSize, string> = { sm: '小', md: '中', lg: '大', xl: '特大' };
export const LINE_HEIGHT_LABELS: Record<LineHeight, string> = { tight: '紧凑', normal: '标准', loose: '宽松' };
export const WIDTH_LABELS: Record<Width, string> = { narrow: '窄', normal: '标准', wide: '宽' };
export const THEME_LABELS: Record<Theme, string> = { auto: '跟随系统', light: '浅色', sepia: '护眼', dark: '深色' };

function pick<T extends string>(allowed: readonly T[], v: string | undefined, fallback: T): T {
  return (allowed as readonly string[]).includes(v ?? '') ? (v as T) : fallback;
}

/** Cookie 形如 `fs=lg&lh=loose&w=wide&th=sepia`，解析失败一律回落默认值。 */
export function parsePrefsCookie(header: string | undefined): Partial<ReadPrefs> {
  if (!header) return {};
  const raw = header
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${PREFS_COOKIE}=`));
  if (!raw) return {};
  let value: string;
  try {
    value = decodeURIComponent(raw.slice(PREFS_COOKIE.length + 1));
  } catch {
    return {};
  }
  const q = new URLSearchParams(value);
  return {
    fs: pick(FONT_SIZES, q.get('fs') ?? undefined, DEFAULT_PREFS.fs),
    lh: pick(LINE_HEIGHTS, q.get('lh') ?? undefined, DEFAULT_PREFS.lh),
    w: pick(WIDTHS, q.get('w') ?? undefined, DEFAULT_PREFS.w),
    th: pick(THEMES, q.get('th') ?? undefined, DEFAULT_PREFS.th),
  };
}

export function serializePrefs(p: ReadPrefs): string {
  return `fs=${p.fs}&lh=${p.lh}&w=${p.w}&th=${p.th}`;
}

/** query 优先于 Cookie，Cookie 优先于默认值。 */
export function resolvePrefs(query: Record<string, string | undefined>, cookieHeader: string | undefined): { prefs: ReadPrefs; fromQuery: boolean } {
  const stored = { ...DEFAULT_PREFS, ...parsePrefsCookie(cookieHeader) };
  const fromQuery = ['fs', 'lh', 'w', 'th'].some((k) => typeof query[k] === 'string');
  return {
    prefs: {
      fs: pick(FONT_SIZES, query.fs, stored.fs),
      lh: pick(LINE_HEIGHTS, query.lh, stored.lh),
      w: pick(WIDTHS, query.w, stored.w),
      th: pick(THEMES, query.th, stored.th),
    },
    fromQuery,
  };
}

export function prefsCookieValue(p: ReadPrefs): string {
  return `${PREFS_COOKIE}=${encodeURIComponent(serializePrefs(p))}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`;
}

/** 非默认项才进 query，链接尽量短，也让默认页面保持干净的 canonical。 */
export function prefsQuery(p: ReadPrefs, override: Partial<ReadPrefs> = {}): string {
  const merged = { ...p, ...override };
  const parts: string[] = [];
  for (const k of ['fs', 'lh', 'w', 'th'] as const) {
    if (merged[k] !== DEFAULT_PREFS[k]) parts.push(`${k}=${merged[k]}`);
  }
  return parts.join('&');
}

/** 把偏好挂到站内链接上（保留已有 query）。 */
export function withPrefs(path: string, p: ReadPrefs, override: Partial<ReadPrefs> = {}): string {
  const q = prefsQuery(p, override);
  if (!q) return path;
  return path.includes('?') ? `${path}&${q}` : `${path}?${q}`;
}

export function prefsClass(p: ReadPrefs): string {
  return `fs-${p.fs} lh-${p.lh} w-${p.w} th-${p.th}`;
}
