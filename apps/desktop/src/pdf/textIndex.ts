import type { PDFPageProxy } from 'pdfjs-dist';
import { normalizePageText } from './anchor';
import { markTextIndexed, upsertPageText } from '@/db/repos/documentsRepo';

interface TextItemLike { str?: string; hasEOL?: boolean }

/** Extract a page's text the same way the text layer lays it out, then normalize. */
export async function extractPageText(page: PDFPageProxy): Promise<string> {
  const content = await page.getTextContent();
  let out = '';
  for (const item of content.items as TextItemLike[]) {
    if (typeof item.str === 'string') out += item.str;
    if (item.hasEOL) out += '\n';
  }
  return normalizePageText(out);
}

/** 建索引只需要「有多少页」和「第 n 页的文本」，任何文档源都能满足。 */
export interface IndexableSource {
  numPages: number;
  pageText(pageNo: number): Promise<string>;
}

export interface IndexOptions {
  onProgress?: (done: number, total: number) => void;
  /** 每页开始前问一次；返回 true 就停下（用户取消 / 页面已卸载） */
  shouldStop?: () => boolean;
}

/** 逐页把文本写进 document_pages（顺带写 FTS）。可中断，中断时不标记「已建索引」。 */
export async function indexDocumentText(source: IndexableSource, documentId: string, options: IndexOptions = {}): Promise<'done' | 'stopped'> {
  const total = source.numPages;
  for (let i = 1; i <= total; i++) {
    if (options.shouldStop?.()) return 'stopped';
    const text = await source.pageText(i);
    await upsertPageText(documentId, i, text);
    options.onProgress?.(i, total);
    // 让出主线程，避免大书把界面卡住
    if (i % 5 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  await markTextIndexed(documentId, total);
  return 'done';
}
