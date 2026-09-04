import type { PDFDocumentProxy } from 'pdfjs-dist';

/** 目前支持阅读的文档类型。 */
export type DocKind = 'pdf' | 'txt' | 'md' | 'epub';

/** 目录节点：pageNo 为空表示这一项解析不出页码（只作为分组标题）。 */
export interface OutlineNode {
  title: string;
  pageNo: number | null;
  children: OutlineNode[];
}

export interface PageSize {
  width: number;
  height: number;
}

/** 文字层体检结果，用于识别扫描版 PDF。 */
export interface TextLayerProbe {
  /** 是否存在可用的文字层 */
  hasText: boolean;
  sampledPages: number;
  avgChars: number;
}

/** 文本类文档的一个排版块。 */
export interface TextBlock {
  type: 'h1' | 'h2' | 'h3' | 'quote' | 'code' | 'li' | 'p';
  text: string;
}

/**
 * 「文档源」统一接口：阅读器只依赖它，不再直接依赖 pdf.js。
 * renderMode 决定用哪个视图渲染：canvas 走 PDF 画布，text 走文本排版。
 */
export interface DocumentSourceBase {
  readonly kind: DocKind;
  readonly numPages: number;
  readonly renderMode: 'canvas' | 'text';
  /** 单页在 scale=1 时的尺寸（CSS 像素） */
  pageSize(pageNo: number): Promise<PageSize>;
  /** 单页的规范化文本（与 normalizePageText 一致） */
  pageText(pageNo: number): Promise<string>;
  /** 目录；没有目录时返回空数组 */
  getOutline(): Promise<OutlineNode[]>;
  /** 文字层体检 */
  probeTextLayer(): Promise<TextLayerProbe>;
  close(): Promise<void>;
}

export interface PdfDocumentSource extends DocumentSourceBase {
  readonly kind: 'pdf';
  readonly renderMode: 'canvas';
  /** 渲染层仍然需要 pdf.js 的原始对象 */
  readonly pdf: PDFDocumentProxy;
}

/**
 * 文本类文档源：TXT / Markdown / EPUB 共用同一套排版块与分页，
 * 于是虚拟滚动、锚点矩形、高亮层、搜索命中层不用为格式做特判。
 */
export interface TextDocumentSource extends DocumentSourceBase {
  readonly kind: 'txt' | 'md' | 'epub';
  readonly renderMode: 'text';
  /** 单页的排版块 */
  pageBlocks(pageNo: number): TextBlock[];
}

export type DocumentSource = PdfDocumentSource | TextDocumentSource;

/** 打开一个尚未支持的格式时抛出，界面据此给出明确提示而不是白屏。 */
export class UnsupportedDocumentError extends Error {
  constructor(readonly kind: string, message: string) {
    super(message);
    this.name = 'UnsupportedDocumentError';
  }
}

/** 打开加密文档且没有口令时抛出。 */
export class EncryptedDocumentError extends Error {
  constructor(message = '这个文档已加密，需要口令才能打开。') {
    super(message);
    this.name = 'EncryptedDocumentError';
  }
}
