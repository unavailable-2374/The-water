/**
 * i18n 类型骨架。
 *
 * 中文词典 `zh` 是唯一事实来源：它用 `as const` 写，字面量类型精确；
 * `Locale` 把这些字面量放宽成 `string`，于是别的语言只需保证**结构一致**。
 *
 * 由此得到两条编译期保证（这是引入多语言机制的核心价值，不是摆设）：
 *   1. 别的语言少写一个 key   → 赋值给 `Locale` 时报 “缺少属性”。
 *   2. 别的语言多写一个 key   → 对象字面量的多余属性检查报错。
 * 也就是说，往 `zh/` 里加一个 key，`en/` 不跟着加就编译不过。
 */

/**
 * 把嵌套结构里的字符串字面量类型放宽成 `string`，其余形状原样保留。
 *
 * 数组也要往里放宽（否则 `as const` 写的 `['一','二','三']` 会把字面量钉死，
 * 别的语言填 `['1','2','3']` 就编译不过），但**长度保持不变**——
 * 同一个 key 在各语言里应当是同样多的条目。
 */
export type Widen<T> =
  T extends string ? string
  : T extends readonly unknown[] ? { [K in keyof T]: Widen<T[K]> }
  : T extends object ? { [K in keyof T]: Widen<T[K]> }
  : T;

/** 支持的语言代码。加一门语言就在这里加一项，然后补一个同结构的词典。 */
export const LOCALES = ['zh-CN', 'en-US'] as const;
export type LocaleCode = (typeof LOCALES)[number];

/** 每种语言在 `<html lang>` 上写的值，以及在设置里显示的名字（用该语言自己的写法）。 */
export const LOCALE_META: Record<LocaleCode, { htmlLang: string; nativeName: string }> = {
  'zh-CN': { htmlLang: 'zh-CN', nativeName: '简体中文' },
  'en-US': { htmlLang: 'en-US', nativeName: 'English' },
};

export const DEFAULT_LOCALE: LocaleCode = 'zh-CN';
