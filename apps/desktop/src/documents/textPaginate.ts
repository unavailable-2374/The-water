import type { DocKind, TextBlock } from './types';

/** 每页的目标字符数：接近一页 A4 的中文排版容量。 */
export const CHARS_PER_PAGE = 1000;

/** 把纯文本 / Markdown 切成排版块。txt 只区分段落。 */
export function parseBlocks(raw: string, kind: DocKind): TextBlock[] {
  const text = raw.replace(/\r\n?/g, '\n');
  if (kind !== 'md') {
    return text
      .split(/\n\s*\n/)
      .map((s) => s.replace(/\n/g, ' ').trim())
      .filter(Boolean)
      .map((s) => ({ type: 'p', text: s }) as TextBlock);
  }
  const out: TextBlock[] = [];
  const lines = text.split('\n');
  let para: string[] = [];
  let fence: string | null = null;
  let code: string[] = [];
  const flushPara = () => {
    const s = para.join(' ').trim();
    if (s) out.push({ type: 'p', text: s });
    para = [];
  };
  for (const line of lines) {
    const fenceHit = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      if (fenceHit && line.trim().startsWith(fence)) {
        out.push({ type: 'code', text: code.join('\n') });
        code = [];
        fence = null;
      } else code.push(line);
      continue;
    }
    if (fenceHit) {
      flushPara();
      fence = fenceHit[1]!;
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      const level = Math.min(3, h[1]!.length);
      out.push({ type: `h${level}` as 'h1' | 'h2' | 'h3', text: inlineText(h[2]!) });
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      flushPara();
      out.push({ type: 'quote', text: inlineText(q[1]!) });
      continue;
    }
    const li = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      out.push({ type: 'li', text: inlineText(li[1]!) });
      continue;
    }
    para.push(inlineText(line.trim()));
  }
  if (fence) out.push({ type: 'code', text: code.join('\n') });
  flushPara();
  return out;
}

/** 去掉行内 Markdown 记号，只留可读文字（阅读器不做富文本渲染）。 */
export function inlineText(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .trim();
}

/**
 * 按目标字符数把块分页。
 * 单块超长时按句读切开，保证任何一页都不会撑爆；标题不落在页尾。
 */
export function paginateBlocks(blocks: TextBlock[], charsPerPage = CHARS_PER_PAGE): TextBlock[][] {
  const pages: TextBlock[][] = [];
  let cur: TextBlock[] = [];
  let count = 0;
  const push = (b: TextBlock) => {
    cur.push(b);
    count += b.text.length + 1;
  };
  const cut = () => {
    if (cur.length) pages.push(cur);
    cur = [];
    count = 0;
  };
  for (const block of blocks) {
    if (isHeading(block) && count > charsPerPage * 0.75) cut();
    for (const piece of splitLongBlock(block, charsPerPage)) {
      if (count > 0 && count + piece.text.length > charsPerPage) cut();
      push(piece);
    }
  }
  cut();
  return pages.length ? pages : [[]];
}

function isHeading(b: TextBlock): boolean {
  return b.type === 'h1' || b.type === 'h2' || b.type === 'h3';
}

/** 超长块按中文句读 / 换行切片，切不动时硬切。 */
export function splitLongBlock(block: TextBlock, limit: number): TextBlock[] {
  if (block.text.length <= limit) return [block];
  const out: TextBlock[] = [];
  let rest = block.text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let at = Math.max(
      window.lastIndexOf('。'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？'),
      window.lastIndexOf('\n'),
      window.lastIndexOf('. '),
    );
    if (at < limit * 0.4) at = limit - 1;
    out.push({ type: block.type, text: rest.slice(0, at + 1).trim() });
    rest = rest.slice(at + 1);
  }
  if (rest.trim()) out.push({ type: block.type, text: rest.trim() });
  return out;
}

/** 一页的纯文本（与 PDF 页文本同样的口径：块之间用换行连接）。 */
export function pageTextOf(page: TextBlock[]): string {
  return page.map((b) => b.text).join('\n');
}

/** 从分好的页里抽目录：Markdown 的 h1/h2/h3。 */
export function outlineFromPages(pages: TextBlock[][]): Array<{ title: string; pageNo: number; level: number }> {
  const out: Array<{ title: string; pageNo: number; level: number }> = [];
  pages.forEach((page, i) => {
    for (const b of page) {
      if (isHeading(b)) out.push({ title: b.text, pageNo: i + 1, level: Number(b.type.slice(1)) });
    }
  });
  return out;
}
