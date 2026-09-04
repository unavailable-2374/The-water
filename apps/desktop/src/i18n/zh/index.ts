/**
 * 简体中文词典 —— 全仓文案的唯一事实来源。
 *
 * 按界面区域拆成若干模块，一是文件不至于滚到几百行，二是多人同时改不同页面时
 * 不会都挤在同一个文件上。加语言时只需照着 `Locale` 类型补一份同结构的词典。
 */
import { a11y, app, common, error, jobs, nav, novelStatus } from './app';
import { chat } from './chat';
import { community } from './community';
import { library } from './library';
import { onboarding } from './onboarding';
import { publicArea } from './publicArea';
import { reader } from './reader';
import { settings } from './settings';
import { studio } from './studio';

export const zh = {
  a11y, app, chat, common, community, error, jobs, library, nav, novelStatus, onboarding, publicArea, reader, settings, studio,
} as const;
