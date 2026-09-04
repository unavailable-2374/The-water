import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
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

/** Index all pages into document_pages. Runs in the background after import; cheap to re-run. */
export async function indexDocumentText(doc: PDFDocumentProxy, documentId: string, onProgress?: (done: number, total: number) => void): Promise<void> {
  const total = doc.numPages;
  for (let i = 1; i <= total; i++) {
    const page = await doc.getPage(i);
    const text = await extractPageText(page);
    await upsertPageText(documentId, i, text);
    page.cleanup();
    onProgress?.(i, total);
  }
  await markTextIndexed(documentId, total);
}
