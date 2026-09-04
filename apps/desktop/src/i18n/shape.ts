/**
 * `Locale` 的定义单独放一个文件，避免 `index.ts` 与各语言词典互相 import 成环。
 * 具体的类型推导原理见 `types.ts` 顶部注释。
 */
import type { zh } from './zh';
import type { Widen } from './types';

/** 一门语言必须提供的全部文案。中文词典是结构上的唯一事实来源。 */
export type Locale = Widen<typeof zh>;
