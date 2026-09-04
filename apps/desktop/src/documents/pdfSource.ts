import type { PDFDocumentProxy } from 'pdfjs-dist';
import { closePdf } from '@/pdf/pdfjs';
import { extractPageText } from '@/pdf/textIndex';
import type { OutlineNode, PageSize, PdfDocumentSource, TextLayerProbe } from './types';

interface RawOutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items?: RawOutlineItem[];
}

/** 用 pdf.js 实现「文档源」。 */
export function pdfDocumentSource(pdf: PDFDocumentProxy): PdfDocumentSource {
  let outlineCache: OutlineNode[] | null = null;
  let probeCache: TextLayerProbe | null = null;
  return {
    kind: 'pdf',
    renderMode: 'canvas',
    numPages: pdf.numPages,
    pdf,
    async pageSize(pageNo: number): Promise<PageSize> {
      const page = await pdf.getPage(pageNo);
      const vp = page.getViewport({ scale: 1 });
      return { width: vp.width, height: vp.height };
    },
    async pageText(pageNo: number): Promise<string> {
      const page = await pdf.getPage(pageNo);
      const text = await extractPageText(page);
      page.cleanup();
      return text;
    },
    async getOutline(): Promise<OutlineNode[]> {
      if (outlineCache) return outlineCache;
      const raw = (await pdf.getOutline().catch(() => null)) as RawOutlineItem[] | null;
      outlineCache = raw ? await Promise.all(raw.map((i) => convert(pdf, i, 0))) : [];
      return outlineCache;
    },
    async probeTextLayer(): Promise<TextLayerProbe> {
      if (probeCache) return probeCache;
      probeCache = await probePdfText(pdf);
      return probeCache;
    },
    async close(): Promise<void> {
      await closePdf(pdf);
    },
  };
}

async function convert(pdf: PDFDocumentProxy, item: RawOutlineItem, depth: number): Promise<OutlineNode> {
  const children = depth < 4 && item.items?.length ? await Promise.all(item.items.map((i) => convert(pdf, i, depth + 1))) : [];
  return { title: (item.title || '').trim() || '（无标题）', pageNo: await destToPage(pdf, item.dest), children };
}

/** 把目录项的 dest 解析成页码；解析不了返回 null（仍然作为标题展示）。 */
export async function destToPage(pdf: PDFDocumentProxy, dest: string | unknown[] | null): Promise<number | null> {
  try {
    if (!dest) return null;
    const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    const ref = (explicit as unknown[] | null)?.[0];
    if (ref == null) return null;
    if (typeof ref === 'number') return ref + 1;
    const index = await pdf.getPageIndex(ref as never);
    return index + 1;
  } catch {
    return null;
  }
}

/** 抽样若干页判断有没有文字层（扫描版 PDF 会全是图）。 */
export async function probePdfText(pdf: PDFDocumentProxy, sample = 6): Promise<TextLayerProbe> {
  const total = pdf.numPages;
  const picks: number[] = [];
  const step = Math.max(1, Math.floor(total / sample));
  for (let n = 1; n <= total && picks.length < sample; n += step) picks.push(n);
  let chars = 0;
  for (const n of picks) {
    try {
      const page = await pdf.getPage(n);
      const text = await extractPageText(page);
      page.cleanup();
      chars += text.length;
    } catch {
      /* 单页读不出就当作没有文字 */
    }
  }
  return assessTextLayer(chars, picks.length);
}

/** 纯逻辑：抽样字符数 → 是否存在可用文字层。 */
export function assessTextLayer(totalChars: number, sampledPages: number): TextLayerProbe {
  const avg = sampledPages > 0 ? totalChars / sampledPages : 0;
  return { hasText: avg >= 16, sampledPages, avgChars: Math.round(avg) };
}
