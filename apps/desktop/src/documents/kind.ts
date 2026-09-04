import type { DocKind } from './types';

/** 已经能读的格式（文件选择器与拖拽都用这一份）。 */
export const READABLE_EXTENSIONS = ['pdf', 'txt', 'md', 'markdown'] as const;
/** 认得出、但还读不了的格式：给明确提示，不做静默失败。 */
export const KNOWN_UNSUPPORTED_EXTENSIONS = ['epub'] as const;

const EXT_TO_KIND: Record<string, DocKind> = {
  pdf: 'pdf',
  txt: 'txt',
  text: 'txt',
  md: 'md',
  markdown: 'md',
  epub: 'epub',
};

/** 取小写扩展名，没有扩展名时返回空串。 */
export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase();
}

/** 从路径推断文档类型；认不出返回 null。 */
export function kindFromPath(path: string): DocKind | null {
  return EXT_TO_KIND[extensionOf(path)] ?? null;
}

/** 是否是当前真正能读的格式。 */
export function isReadable(path: string): boolean {
  const k = kindFromPath(path);
  return k === 'pdf' || k === 'txt' || k === 'md';
}

/** 去掉扩展名，作为默认书名。 */
export function titleFromPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const i = name.lastIndexOf('.');
  return i <= 0 ? name : name.slice(0, i);
}

/** 存盘时用的扩展名：md/markdown 统一存成 .md。 */
export function storageExtension(kind: DocKind): string {
  return kind === 'md' ? 'md' : kind;
}

/** 文本类文档的存放目录；PDF 沿用历史目录 pdfs。 */
export function storageDirFor(kind: DocKind): string {
  return kind === 'pdf' ? 'pdfs' : 'docs';
}
