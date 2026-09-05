/**
 * 界面文案入口。全仓统一 `import { t, fmt } from '@/i18n'`。
 *
 * ## 为什么 `t` 是个 Proxy
 * 语言可以在运行时切换，而 `t` 在各处是以模块顶层 `import` 的形式拿到的。
 * 如果 `t` 直接指向某个词典对象，切换语言后所有已经读过的引用都会停留在旧语言，
 * 尤其是那种在模块顶层写 `const LABELS = { a: t.x.y }` 的表——正是本次要消灭的东西。
 * 所以 `t` 是一层惰性代理：每次取值都回当前词典里读，取到子对象再包一层同样的代理。
 * 于是「模块顶层拿到的引用」和「渲染时拿到的引用」永远一致。
 *
 * ## 类型约束
 * `Locale` 由中文词典结构推导而来（见 `types.ts` 与 `shape.ts`）。任何一门语言少 key 或多 key
 * 都是编译错误，所以往 `zh/` 里加文案时，`en/` 不跟着加就编不过去。
 */
import { create } from 'zustand';
import { zh } from './zh';
import { en } from './en';
import { pickPreferredLocale, readStoredLocale, resolveLocale, writeStoredLocale } from './locale';
import { DEFAULT_LOCALE, LOCALES, LOCALE_META, type LocaleCode } from './types';
import type { Locale } from './shape';

export type { Locale };

const DICTS: Record<LocaleCode, Locale> = { 'zh-CN': zh, 'en-US': en };

let current: LocaleCode = DEFAULT_LOCALE;

/** 当前语言代码。 */
export function currentLocale(): LocaleCode {
  return current;
}

/** 惰性代理：始终从「当前语言的词典」里取值。 */
function liveDict<T extends object>(pick: () => T): T {
  return new Proxy({} as T, {
    get(_target, key) {
      const value = (pick() as Record<PropertyKey, unknown>)[key];
      if (typeof value === 'object' && value !== null) return liveDict(() => (pick() as Record<PropertyKey, object>)[key] as object);
      return value;
    },
    has(_target, key) {
      return key in pick();
    },
    ownKeys() {
      return Reflect.ownKeys(pick());
    },
    getOwnPropertyDescriptor(_target, key) {
      const desc = Reflect.getOwnPropertyDescriptor(pick(), key);
      return desc === undefined ? undefined : { ...desc, configurable: true };
    },
  });
}

/** 全仓文案。`t.settings.baseUrl` 这样用即可，不需要关心当前是哪门语言。 */
export const t: Locale = liveDict(() => DICTS[current]);

/** 语言版本号，只用来在切换语言时把整棵 React 树重画一遍。 */
interface LocaleState { code: LocaleCode; set: (code: LocaleCode) => void }
const useLocaleStore = create<LocaleState>((set) => ({ code: DEFAULT_LOCALE, set: (code) => set({ code }) }));

/** 组件里订阅当前语言：语言一变，用到它的组件就重渲染。 */
export function useLocale(): LocaleCode {
  return useLocaleStore((s) => s.code);
}

function paint(code: LocaleCode): void {
  current = code;
  if (typeof document !== 'undefined') document.documentElement.lang = LOCALE_META[code].htmlLang;
  useLocaleStore.getState().set(code);
}

/** 切换语言：立刻生效并记住选择。 */
export function setLocale(tag: string): LocaleCode {
  const code = resolveLocale(tag);
  writeStoredLocale(code);
  paint(code);
  return code;
}

/**
 * 启动最早期调用（在 React 挂载之前）：按「上次选择 → 系统语言 → 简体中文」定下语言，
 * 顺手把 `<html lang>` 写对——index.html 里那个值只是个占位。
 */
export function initLocale(): LocaleCode {
  const stored = readStoredLocale();
  const code = stored ?? pickPreferredLocale(typeof navigator === 'undefined' ? undefined : navigator.languages);
  paint(code);
  return code;
}

/** 供设置页列语言用。 */
export function availableLocales(): ReadonlyArray<{ code: LocaleCode; nativeName: string }> {
  return LOCALES.map((code) => ({ code, nativeName: LOCALE_META[code].nativeName }));
}

/**
 * 把 `{name}` 这样的占位符替换掉。
 *
 * 类型上 `s` 必填，但动态取值（`t.jobs.type[job.type]`）在运行时可能落空 ——
 * 本地库里的任务类型可能来自更新或更旧的版本。少一句文案不该白屏整个页面，
 * 所以这里降级为空串并留一条 warn（会被 installDiagnostics 转发进日志文件）。
 */
export function fmt(s: string, vars: Record<string, string | number>): string {
  if (typeof s !== 'string') {
    console.warn('[i18n] fmt 收到缺失的文案，已降级为空串', { vars });
    return '';
  }
  return s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}

export { LOCALES, LOCALE_META, DEFAULT_LOCALE } from './types';
export type { LocaleCode } from './types';
export { resolveLocale, pickPreferredLocale, languageOf } from './locale';
