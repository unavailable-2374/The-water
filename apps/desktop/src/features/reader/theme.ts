import { t } from '@/i18n';
import type { ReaderTheme } from '@/stores/readerStore';

export interface ReaderThemeSpec {
  key: ReaderTheme;
  /** 界面上显示的主题名 */
  label: string;
  /** 书页底色 */
  pageBg: string;
  /** 画布滤镜：夜读整页反色，护眼压一点色温 */
  canvasFilter: string;
  /** 阅读区（书页之外）的底色 */
  stageBg: string;
  /** 文本类文档的正文颜色 */
  textColor: string;
  /** 文本类文档里的次要文字（引用、代码） */
  mutedColor: string;
}

/**
 * 三套阅读主题。`label` 写成 getter：这张表是模块顶层常量，
 * 直接把 `t.reader.themes.*` 拷进来的话，切语言后主题名不会跟着变。
 */
export const READER_THEMES: Record<ReaderTheme, ReaderThemeSpec> = {
  paper: {
    key: 'paper',
    get label() { return t.reader.themes.paper; },
    pageBg: '#ffffff',
    canvasFilter: 'none',
    stageBg: 'transparent',
    textColor: '#2b2b2b',
    mutedColor: '#6b6b6b',
  },
  night: {
    key: 'night',
    get label() { return t.reader.themes.night; },
    pageBg: '#14161a',
    canvasFilter: 'invert(1) hue-rotate(180deg) brightness(0.92) contrast(1.05)',
    stageBg: '#0c0d10',
    textColor: '#d6d3cc',
    mutedColor: '#9a978f',
  },
  eye: {
    key: 'eye',
    get label() { return t.reader.themes.eye; },
    pageBg: '#f3e9d2',
    canvasFilter: 'sepia(0.35) saturate(0.92) brightness(0.99)',
    stageBg: '#e7dcc2',
    textColor: '#3a3226',
    mutedColor: '#6f6552',
  },
};

export const THEME_ORDER: ReaderTheme[] = ['paper', 'night', 'eye'];
