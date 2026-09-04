/**
 * English dictionary.
 *
 * 结构必须与 `i18n/zh` 完全一致：少一个 key 或多一个 key 都是编译错误
 * （`Locale` 由中文词典推导，见 `i18n/shape.ts`）。
 * 尚未翻译的命名空间会临时指向中文词典，并在文件里显式标注出来。
 */
import type { Locale } from '../shape';
import { a11y, app, common, error, jobs, nav, novelStatus } from './app';
import { chat } from './chat';
import { community } from './community';
import { library } from './library';
import { onboarding } from './onboarding';
import { publicArea } from './publicArea';
import { reader } from './reader';
import { settings } from './settings';
import { studio } from './studio';

export const en: Locale = {
  a11y, app, chat, common, community, error, jobs, library, nav, novelStatus, onboarding, publicArea, reader, settings, studio,
};
