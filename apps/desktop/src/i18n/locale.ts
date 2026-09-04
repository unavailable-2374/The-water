/**
 * 语言的解析、回退与持久化 —— 纯逻辑，可单测。
 *
 * 回退顺序：显式选择 → 浏览器/系统语言 → 简体中文。
 * 匹配规则从严到宽：完全相同 → 同语言不同地区（zh-TW 也回落到 zh-CN）→ 默认语言。
 */
import { DEFAULT_LOCALE, LOCALES, type LocaleCode } from './types';

/** 取语言标签的语言部分：`zh-Hans-CN` → `zh`。 */
export function languageOf(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/)[0] ?? '';
}

/**
 * 把任意语言标签收敛成一个受支持的语言代码。
 * 认不出来（包括 null / 空串 / 乱码）就返回默认语言，绝不抛错。
 */
export function resolveLocale(tag: string | null | undefined, available: readonly LocaleCode[] = LOCALES): LocaleCode {
  const fallback = available.includes(DEFAULT_LOCALE) ? DEFAULT_LOCALE : (available[0] ?? DEFAULT_LOCALE);
  if (typeof tag !== 'string' || tag.trim() === '') return fallback;
  const wanted = tag.trim().toLowerCase();
  const exact = available.find((l) => l.toLowerCase() === wanted);
  if (exact) return exact;
  const lang = languageOf(wanted);
  if (lang === '') return fallback;
  const sameLanguage = available.find((l) => languageOf(l) === lang);
  return sameLanguage ?? fallback;
}

/** 按浏览器/系统给的偏好列表挑第一个能对上的语言。 */
export function pickPreferredLocale(preferred: readonly string[] | undefined, available: readonly LocaleCode[] = LOCALES): LocaleCode {
  for (const tag of preferred ?? []) {
    const lang = languageOf(tag);
    if (lang === '') continue;
    const hit = available.find((l) => l.toLowerCase() === tag.trim().toLowerCase()) ?? available.find((l) => languageOf(l) === lang);
    if (hit) return hit;
  }
  return resolveLocale(null, available);
}

/** localStorage 里存语言选择的键；和主题缓存一样，只是为了首屏不闪。 */
export const LOCALE_STORAGE_KEY = 'locale';

export function readStoredLocale(): LocaleCode | null {
  try {
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (raw === null) return null;
    // 存进去的一定是合法值，但用户可能手改过，所以照样过一遍解析。
    return resolveLocale(raw);
  } catch {
    return null;
  }
}

export function writeStoredLocale(code: LocaleCode): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, code);
  } catch {
    /* 隐私模式等场景写不了，下次启动重新按系统语言判断即可 */
  }
}
