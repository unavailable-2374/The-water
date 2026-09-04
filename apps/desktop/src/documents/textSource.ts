import { normalizePageText } from '@/pdf/anchor';
import type { OutlineNode, PageSize, TextBlock, TextDocumentSource, TextLayerProbe } from './types';
import { CHARS_PER_PAGE, outlineFromPages, pageTextOf, paginateBlocks, parseBlocks } from './textPaginate';

/** 文本页的版心尺寸（scale=1，CSS 像素）——固定尺寸才能和 PDF 共用同一套虚拟滚动与矩形锚点。 */
export const TEXT_PAGE_SIZE: PageSize = { width: 720, height: 1040 };

/** 用 TXT / Markdown 原文构造「文档源」。 */
export function textDocumentSource(raw: string, kind: 'txt' | 'md'): TextDocumentSource {
  const pages = paginateBlocks(parseBlocks(raw, kind), CHARS_PER_PAGE);
  const outline: OutlineNode[] = nestOutline(outlineFromPages(pages));
  return {
    kind,
    renderMode: 'text',
    numPages: pages.length,
    async pageSize(): Promise<PageSize> {
      return TEXT_PAGE_SIZE;
    },
    async pageText(pageNo: number): Promise<string> {
      return normalizePageText(pageTextOf(pages[pageNo - 1] ?? []));
    },
    pageBlocks(pageNo: number): TextBlock[] {
      return pages[pageNo - 1] ?? [];
    },
    async getOutline(): Promise<OutlineNode[]> {
      return outline;
    },
    async probeTextLayer(): Promise<TextLayerProbe> {
      const chars = pages.reduce((n, p) => n + pageTextOf(p).length, 0);
      return { hasText: chars > 0, sampledPages: pages.length, avgChars: pages.length ? Math.round(chars / pages.length) : 0 };
    },
    async close(): Promise<void> {
      /* 纯内存，无需释放 */
    },
  };
}

/** 把带 level 的平铺标题折成树。 */
export function nestOutline(flat: Array<{ title: string; pageNo: number; level: number }>): OutlineNode[] {
  const root: OutlineNode[] = [];
  const stack: Array<{ level: number; node: OutlineNode }> = [];
  for (const item of flat) {
    const node: OutlineNode = { title: item.title, pageNo: item.pageNo, children: [] };
    while (stack.length && stack[stack.length - 1]!.level >= item.level) stack.pop();
    if (stack.length) stack[stack.length - 1]!.node.children.push(node);
    else root.push(node);
    stack.push({ level: item.level, node });
  }
  return root;
}
