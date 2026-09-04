/** 四色高亮调色板：气泡里选色，笔记面板里改色，页面渲染取同一份。 */
export interface HighlightColor {
  key: string;
  label: string;
  css: string;
}

export const HIGHLIGHT_COLORS: HighlightColor[] = [
  { key: 'yellow', label: '黄', css: 'var(--color-highlight-yellow)' },
  { key: 'green', label: '绿', css: 'var(--color-highlight-green)' },
  { key: 'blue', label: '蓝', css: 'var(--color-highlight-blue)' },
  { key: 'pink', label: '粉', css: 'var(--color-highlight-pink)' },
];

export const DEFAULT_HIGHLIGHT_COLOR = 'yellow';

export function colorCss(key: string): string {
  return (HIGHLIGHT_COLORS.find((c) => c.key === key) ?? HIGHLIGHT_COLORS[0]!).css;
}
