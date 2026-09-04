/**
 * 主题三选（跟随系统 / 浅色 / 深色）。
 *
 * 生效链路：设置页写 `theme` 设置 → settingsStore.update → applyTheme →
 * 在 <html> 上写 `data-theme="light|dark"` → index.css 里的 `@custom-variant dark`
 * 让所有 `dark:` 类跟着这个属性走。跟随系统时监听 matchMedia，系统切换即时重绘。
 */

export type ThemePref = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_PREFS: readonly ThemePref[] = ['system', 'light', 'dark'];

/** 首屏闪烁兜底：把上次选择缓存在 localStorage，settings 还没读出来时先按它画。 */
const CACHE_KEY = 'theme';

/** 计算最终生效的主题。 */
export function resolveTheme(pref: ThemePref, prefersDark: boolean): ResolvedTheme {
  if (pref === 'light' || pref === 'dark') return pref;
  return prefersDark ? 'dark' : 'light';
}

/** 把任意来源的值收敛成合法的主题偏好，认不出就当「跟随系统」。 */
export function normalizeThemePref(value: unknown): ThemePref {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

let currentPref: ThemePref = 'system';
let watcher: MediaQueryList | null = null;

function darkMediaQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  if (!watcher) {
    watcher = window.matchMedia('(prefers-color-scheme: dark)');
    watcher.addEventListener('change', paint);
  }
  return watcher;
}

function paint(): void {
  if (typeof document === 'undefined') return;
  const resolved = resolveTheme(currentPref, darkMediaQuery()?.matches ?? false);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  // 让原生控件（滚动条、下拉、输入框）也跟着换。
  root.style.colorScheme = resolved;
}

/** 应用主题偏好，并在「跟随系统」时保持监听。 */
export function applyTheme(pref: ThemePref): void {
  currentPref = normalizeThemePref(pref);
  try {
    localStorage.setItem(CACHE_KEY, currentPref);
  } catch {
    /* 隐私模式等场景写不了，无所谓 */
  }
  paint();
}

/** 启动最早期调用：先按缓存的偏好画一遍，避免 settings 读出来之前闪一下。 */
export function applyCachedTheme(): void {
  let cached: string | null = null;
  try {
    cached = localStorage.getItem(CACHE_KEY);
  } catch {
    cached = null;
  }
  currentPref = normalizeThemePref(cached);
  paint();
}
