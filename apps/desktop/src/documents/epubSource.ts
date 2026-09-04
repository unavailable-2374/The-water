/**
 * EPUB 文档源。
 *
 * 流程：解 zip → 读 `META-INF/container.xml` 找到 OPF → 解析 OPF 的 manifest / spine / metadata
 * → 按 spine 顺序把每篇 XHTML 压成 `TextBlock[]` → 每篇各自分页（章节从新的一页开始）
 * → 目录优先取 EPUB3 的 nav.xhtml，没有就退回 EPUB2 的 toc.ncx。
 *
 * 排版块与分页跟 TXT / Markdown 完全同源（`textPaginate.ts`），
 * 所以虚拟滚动、锚点矩形、高亮层、搜索命中层不需要为 EPUB 做任何特判。
 */
import { unzipSync } from 'fflate';
import { normalizePageText } from '@/pdf/anchor';
import { decodeText } from './decode';
import { CHARS_PER_PAGE, pageTextOf, paginateBlocks } from './textPaginate';
import { nestOutline } from './textSource';
import { TEXT_PAGE_SIZE } from './textSource';
import { localName, sliceElement, tokenize, xhtmlToBlocks } from './xhtml';
import { UnsupportedDocumentError, type OutlineNode, type PageSize, type TextBlock, type TextDocumentSource, type TextLayerProbe } from './types';

export interface EpubMeta {
  title: string | null;
  author: string | null;
  language: string | null;
}

export interface EpubChapter {
  /** zip 内的路径 */
  path: string;
  blocks: TextBlock[];
  /** 元素 id → 块下标 */
  anchors: Map<string, number>;
  /** 这一章的首页页码（1 起） */
  startPage: number;
  pageCount: number;
}

export interface EpubBook {
  meta: EpubMeta;
  pages: TextBlock[][];
  outline: OutlineNode[];
  chapters: EpubChapter[];
}

/** 目录里的一条（还没折成树）。 */
export interface FlatTocEntry {
  title: string;
  href: string;
  level: number;
}

// ── 路径 ───────────────────────────────────────────────────────────────────

/** 去掉 `.` 与 `..` 段。 */
export function normalizeZipPath(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** 把 manifest / 目录里的 href（可能带锚点、可能是百分号编码）解析成 zip 内路径。 */
export function resolveHref(baseDir: string, href: string): string {
  const withoutHash = href.split('#')[0]!.split('?')[0]!;
  let clean = withoutHash;
  try {
    clean = decodeURIComponent(withoutHash);
  } catch {
    /* 编码坏了就用原文 */
  }
  if (clean.startsWith('/')) return normalizeZipPath(clean);
  return normalizeZipPath(baseDir ? `${baseDir}/${clean}` : clean);
}

/** href 里 `#` 之后的锚点，没有返回 null。 */
export function fragmentOf(href: string): string | null {
  const i = href.indexOf('#');
  if (i < 0) return null;
  const raw = href.slice(i + 1);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// ── zip ────────────────────────────────────────────────────────────────────

type Entries = Record<string, Uint8Array>;

/** 取 zip 里的一个文件，找不到就按大小写不敏感再找一遍。 */
function entry(entries: Entries, path: string): Uint8Array | null {
  const hit = entries[path];
  if (hit) return hit;
  const lower = path.toLowerCase();
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.toLowerCase() === lower) return bytes;
  }
  return null;
}

function entryText(entries: Entries, path: string): string | null {
  const bytes = entry(entries, path);
  return bytes ? decodeText(bytes) : null;
}

// ── OPF ────────────────────────────────────────────────────────────────────

export interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties: string;
}

export interface OpfData {
  meta: EpubMeta;
  manifest: Map<string, ManifestItem>;
  /** spine 里的 idref 顺序（已剔除 linear="no"） */
  spine: string[];
  /** spine 的 toc 属性（EPUB2 的 ncx id） */
  tocId: string | null;
}

/** 解析 OPF：只取我们要用的 metadata / manifest / spine。 */
export function parseOpf(xml: string): OpfData {
  const meta: EpubMeta = { title: null, author: null, language: null };
  const metadata = sliceElement(xml, 'metadata')?.inner ?? xml;
  let current: 'title' | 'creator' | 'language' | null = null;
  let buf = '';
  for (const token of tokenize(metadata)) {
    if (token.type === 'text') {
      if (current) buf += token.text;
      continue;
    }
    const name = localName(token.name);
    if (!token.closing && (name === 'title' || name === 'creator' || name === 'language')) {
      current = name;
      buf = '';
    } else if (token.closing && name === current) {
      const value = buf.replace(/\s+/g, ' ').trim();
      if (value && !meta[current === 'creator' ? 'author' : current]) {
        if (current === 'creator') meta.author = value;
        else meta[current] = value;
      }
      current = null;
      buf = '';
    }
  }

  const manifest = new Map<string, ManifestItem>();
  const manifestXml = sliceElement(xml, 'manifest')?.inner ?? xml;
  for (const token of tokenize(manifestXml)) {
    if (token.type !== 'tag' || token.closing || localName(token.name) !== 'item') continue;
    const { id, href } = token.attrs;
    if (!id || !href) continue;
    manifest.set(id, {
      id,
      href,
      mediaType: token.attrs['media-type'] ?? '',
      properties: token.attrs.properties ?? '',
    });
  }

  const spine: string[] = [];
  const spineEl = sliceElement(xml, 'spine');
  for (const token of tokenize(spineEl?.inner ?? '')) {
    if (token.type !== 'tag' || token.closing || localName(token.name) !== 'itemref') continue;
    const idref = token.attrs.idref;
    if (!idref) continue;
    if ((token.attrs.linear ?? '').toLowerCase() === 'no') continue;
    spine.push(idref);
  }
  return { meta, manifest, spine, tocId: spineEl?.attrs.toc ?? null };
}

/** 从 container.xml 里取 OPF 路径。 */
export function opfPathFromContainer(xml: string): string | null {
  for (const token of tokenize(xml)) {
    if (token.type !== 'tag' || token.closing || localName(token.name) !== 'rootfile') continue;
    const full = token.attrs['full-path'];
    if (full) return normalizeZipPath(full);
  }
  return null;
}

// ── 目录 ───────────────────────────────────────────────────────────────────

/** EPUB3 的 nav.xhtml：取 `epub:type="toc"` 的那个 nav，按 ol 嵌套定层级。 */
export function parseNavToc(xhtml: string): FlatTocEntry[] {
  const nav =
    sliceElement(xhtml, 'nav', (a) => /(^|\s)toc(\s|$)/.test(a['epub:type'] ?? a.type ?? '')) ??
    sliceElement(xhtml, 'nav');
  if (!nav) return [];
  const out: FlatTocEntry[] = [];
  let depth = 0;
  let href: string | null = null;
  let buf = '';
  for (const token of tokenize(nav.inner)) {
    if (token.type === 'text') {
      if (href !== null) buf += token.text;
      continue;
    }
    const name = localName(token.name);
    if (name === 'ol' || name === 'ul') {
      depth += token.closing ? -1 : token.selfClosing ? 0 : 1;
      continue;
    }
    if (name === 'a' && !token.closing) {
      href = token.attrs.href ?? '';
      buf = '';
      continue;
    }
    if (name === 'a' && token.closing && href !== null) {
      const title = buf.replace(/\s+/g, ' ').trim();
      if (title && href) out.push({ title, href, level: Math.max(1, depth) });
      href = null;
      buf = '';
    }
  }
  return out;
}

/** EPUB2 的 toc.ncx：navPoint 嵌套即层级。 */
export function parseNcxToc(xml: string): FlatTocEntry[] {
  const out: FlatTocEntry[] = [];
  let depth = 0;
  let inText = false;
  let title = '';
  let buf = '';
  for (const token of tokenize(xml)) {
    if (token.type === 'text') {
      if (inText) buf += token.text;
      continue;
    }
    const name = localName(token.name);
    if (name === 'navpoint') {
      depth += token.closing ? -1 : token.selfClosing ? 0 : 1;
      if (!token.closing) title = '';
      continue;
    }
    if (name === 'text') {
      if (token.closing) {
        inText = false;
        title = buf.replace(/\s+/g, ' ').trim();
      } else {
        inText = true;
        buf = '';
      }
      continue;
    }
    if (name === 'content' && !token.closing) {
      const src = token.attrs.src ?? '';
      if (src && title) out.push({ title, href: src, level: Math.max(1, depth) });
    }
  }
  return out;
}

// ── 解析整本书 ──────────────────────────────────────────────────────────────

/** 一页大约装多少字（跟 TXT / Markdown 用同一个口径）。 */
function paginateChapter(blocks: TextBlock[]): TextBlock[][] {
  return blocks.length === 0 ? [] : paginateBlocks(blocks, CHARS_PER_PAGE);
}

/** 按 `paginateBlocks` 的口径算每页的字符权重，用来把章内锚点落到具体页。 */
function pageWeights(pages: TextBlock[][]): number[] {
  return pages.map((page) => page.reduce((n, b) => n + b.text.length + 1, 0));
}

/** 章内第 blockIndex 块落在这一章的第几页（0 起）。 */
export function pageOffsetOfBlock(pages: TextBlock[][], blocks: TextBlock[], blockIndex: number): number {
  if (pages.length <= 1 || blockIndex <= 0) return 0;
  let target = 0;
  for (let i = 0; i < blockIndex && i < blocks.length; i += 1) target += blocks[i]!.text.length + 1;
  let seen = 0;
  const weights = pageWeights(pages);
  for (let i = 0; i < weights.length; i += 1) {
    seen += weights[i]!;
    if (target < seen) return i;
  }
  return pages.length - 1;
}

const XHTML_TYPES = /xhtml|html|xml/i;

/** 解析一本 EPUB。字节坏了 / 不是 EPUB 抛 `UnsupportedDocumentError`。 */
export function parseEpub(bytes: Uint8Array): EpubBook {
  let entries: Entries;
  try {
    entries = unzipSync(bytes) as Entries;
  } catch (e) {
    throw new UnsupportedDocumentError('epub', `这个 EPUB 解不开（不是有效的 zip）：${e instanceof Error ? e.message : String(e)}`);
  }

  const containerXml = entryText(entries, 'META-INF/container.xml');
  let opfPath = containerXml ? opfPathFromContainer(containerXml) : null;
  if (!opfPath) {
    // 有些工具产出的包缺 container.xml，退回按扩展名找
    opfPath = Object.keys(entries).find((n) => n.toLowerCase().endsWith('.opf')) ?? null;
  }
  if (!opfPath) throw new UnsupportedDocumentError('epub', '这个 EPUB 里找不到 OPF 清单，文件可能损坏了。');
  const opfXml = entryText(entries, opfPath);
  if (!opfXml) throw new UnsupportedDocumentError('epub', `这个 EPUB 的清单文件读不出来：${opfPath}`);

  const opf = parseOpf(opfXml);
  const opfDir = dirOf(opfPath);

  const chapters: EpubChapter[] = [];
  const pages: TextBlock[][] = [];
  /** zip 路径 → 章节下标，目录用它把 href 映射到页码 */
  const byPath = new Map<string, number>();

  for (const idref of opf.spine) {
    const item = opf.manifest.get(idref);
    if (!item) continue;
    if (item.mediaType && !XHTML_TYPES.test(item.mediaType)) continue;
    const path = resolveHref(opfDir, item.href);
    const text = entryText(entries, path);
    if (text === null) continue;
    const { blocks, anchors } = xhtmlToBlocks(text);
    const chapterPages = paginateChapter(blocks);
    if (chapterPages.length === 0) continue;
    byPath.set(path, chapters.length);
    chapters.push({ path, blocks, anchors, startPage: pages.length + 1, pageCount: chapterPages.length });
    pages.push(...chapterPages);
  }

  if (pages.length === 0) {
    throw new UnsupportedDocumentError('epub', '这个 EPUB 里没有解析出任何正文，可能是纯图片书或加了 DRM。');
  }

  // 目录：EPUB3 nav 优先，退回 EPUB2 ncx
  let flat: FlatTocEntry[] = [];
  let tocDir = opfDir;
  const navItem = [...opf.manifest.values()].find((i) => /(^|\s)nav(\s|$)/.test(i.properties));
  if (navItem) {
    const navPath = resolveHref(opfDir, navItem.href);
    const navXml = entryText(entries, navPath);
    if (navXml) {
      flat = parseNavToc(navXml);
      tocDir = dirOf(navPath);
    }
  }
  if (flat.length === 0) {
    const ncxItem =
      (opf.tocId ? opf.manifest.get(opf.tocId) : undefined) ??
      [...opf.manifest.values()].find((i) => i.mediaType === 'application/x-dtbncx+xml');
    if (ncxItem) {
      const ncxPath = resolveHref(opfDir, ncxItem.href);
      const ncxXml = entryText(entries, ncxPath);
      if (ncxXml) {
        flat = parseNcxToc(ncxXml);
        tocDir = dirOf(ncxPath);
      }
    }
  }

  const outlineFlat = flat
    .map((e) => {
      const path = resolveHref(tocDir, e.href);
      const chapterIndex = byPath.get(path);
      if (chapterIndex === undefined) return null;
      const chapter = chapters[chapterIndex]!;
      const fragment = fragmentOf(e.href);
      let offset = 0;
      if (fragment) {
        const blockIndex = chapter.anchors.get(fragment);
        if (blockIndex !== undefined) {
          const chapterPages = pages.slice(chapter.startPage - 1, chapter.startPage - 1 + chapter.pageCount);
          offset = pageOffsetOfBlock(chapterPages, chapter.blocks, blockIndex);
        }
      }
      return { title: e.title, pageNo: chapter.startPage + offset, level: e.level };
    })
    .filter((x): x is { title: string; pageNo: number; level: number } => x !== null);

  const outline = outlineFlat.length > 0 ? nestOutline(outlineFlat) : nestOutline(headingOutline(pages));

  return { meta: opf.meta, pages, outline, chapters };
}

/** 没有目录（或目录一条都对不上）时，退回按正文标题生成目录。 */
function headingOutline(pages: TextBlock[][]): Array<{ title: string; pageNo: number; level: number }> {
  const out: Array<{ title: string; pageNo: number; level: number }> = [];
  pages.forEach((page, i) => {
    for (const b of page) {
      if (b.type === 'h1' || b.type === 'h2' || b.type === 'h3') out.push({ title: b.text, pageNo: i + 1, level: Number(b.type.slice(1)) });
    }
  });
  return out;
}

/** 用 EPUB 字节构造「文档源」。 */
export function epubDocumentSource(bytes: Uint8Array): TextDocumentSource & { meta: EpubMeta } {
  const book = parseEpub(bytes);
  const { pages } = book;
  return {
    kind: 'epub',
    renderMode: 'text',
    numPages: pages.length,
    meta: book.meta,
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
      return book.outline;
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
