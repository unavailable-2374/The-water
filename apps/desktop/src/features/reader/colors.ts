/** 四色高亮调色板：气泡里选色，笔记面板里改色，页面渲染取同一份。 */
import { t } from '@/i18n';

export interface HighlightColor {
  key: string;
  /** 界面上显示的颜色名 */
  label: string;
  css: string;
}

/**
 * `label` 写成 getter：这张表是模块顶层常量，直接把 `t.reader.colors.*` 拷进来的话，
 * 切语言后颜色名不会跟着变。
 */
export const HIGHLIGHT_COLORS: HighlightColor[] = [
  { key: 'yellow', get label() { return t.reader.colors.yellow; }, css: 'var(--color-highlight-yellow)' },
  { key: 'green', get label() { return t.reader.colors.green; }, css: 'var(--color-highlight-green)' },
  { key: 'blue', get label() { return t.reader.colors.blue; }, css: 'var(--color-highlight-blue)' },
  { key: 'pink', get label() { return t.reader.colors.pink; }, css: 'var(--color-highlight-pink)' },
];

export const DEFAULT_HIGHLIGHT_COLOR = 'yellow';

export function colorCss(key: string): string {
  return (HIGHLIGHT_COLORS.find((c) => c.key === key) ?? HIGHLIGHT_COLORS[0]!).css;
}

/** 颜色名；未知颜色返回空串（导出时据此省掉括号）。 */
export function colorLabel(key: string): string {
  return HIGHLIGHT_COLORS.find((c) => c.key === key)?.label ?? '';
}
