/**
 * 极简 XML / XHTML 扫描器。
 *
 * EPUB 要在两个地方解析标记：容器与 OPF（纯 XML）、正文（XHTML）。
 * 这里不引第三方解析器，也不用 DOMParser —— 单元测试跑在 node 环境里没有 DOM，
 * 而阅读器只需要「文字 + 结构层级」，不做富文本渲染。
 */
import type { TextBlock } from './types';

/** 一次扫描吐出的标签。 */
export interface XmlTag {
  name: string;
  attrs: Record<string, string>;
  closing: boolean;
  selfClosing: boolean;
}

/** 文本节点或标签。 */
export type XmlToken = { type: 'text'; text: string } | ({ type: 'tag' } & XmlTag);

const TOKEN_RE =
  /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/\s*([A-Za-z_][\w.:-]*)\s*>|<\s*([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

const ATTR_RE = /([A-Za-z_:][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  laquo: '«', raquo: '»', middot: '·', bull: '·', copy: '©', reg: '®', trade: '™',
  deg: '°', times: '×', divide: '÷', shy: '', ensp: ' ', emsp: ' ', thinsp: ' ',
};

/** 解 XML / HTML 实体。认不出的原样留着，绝不吞字。 */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (m, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    const named = NAMED_ENTITIES[body];
    return named === undefined ? m : named;
  });
}

/** 解析标签体里的属性。属性名统一转小写。 */
export function parseAttrs(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(body)) !== null) {
    out[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** 把一段标记切成「文本 / 标签」序列。注释、DOCTYPE、处理指令直接丢掉，CDATA 当文本。 */
export function tokenize(markup: string): XmlToken[] {
  const out: XmlToken[] = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const pushText = (raw: string): void => {
    if (raw) out.push({ type: 'text', text: raw });
  };
  while ((m = TOKEN_RE.exec(markup)) !== null) {
    pushText(markup.slice(last, m.index));
    last = TOKEN_RE.lastIndex;
    const [, cdata, closeName, openName, attrBody, slash] = m;
    if (cdata !== undefined) {
      pushText(cdata);
    } else if (closeName !== undefined) {
      out.push({ type: 'tag', name: closeName.toLowerCase(), attrs: {}, closing: true, selfClosing: false });
    } else if (openName !== undefined) {
      out.push({
        type: 'tag',
        name: openName.toLowerCase(),
        attrs: parseAttrs(attrBody ?? ''),
        closing: false,
        selfClosing: slash === '/',
      });
    }
    // 其余（注释 / DOCTYPE / <? ?>）忽略
  }
  pushText(markup.slice(last));
  return out;
}

/** 取本地名：去掉 `dc:` `opf:` 这类命名空间前缀。 */
export function localName(name: string): string {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
}

/**
 * 找出第一个满足条件的元素，返回它的属性与内层标记（按同名标签配对，允许嵌套）。
 * 找不到返回 null。
 */
export function sliceElement(
  markup: string,
  tagName: string,
  match: (attrs: Record<string, string>) => boolean = () => true,
): { attrs: Record<string, string>; inner: string } | null {
  const open = new RegExp(`<\\s*${tagName}((?:"[^"]*"|'[^']*'|[^>"'])*?)(/?)>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = open.exec(markup)) !== null) {
    const attrs = parseAttrs(m[1] ?? '');
    if (!match(attrs)) continue;
    if (m[2] === '/') return { attrs, inner: '' };
    const start = open.lastIndex;
    const pair = new RegExp(`<\\s*(/?)\\s*${tagName}(?:"[^"]*"|'[^']*'|[^>"'])*?>`, 'gi');
    pair.lastIndex = start;
    let depth = 1;
    let s: RegExpExecArray | null;
    while ((s = pair.exec(markup)) !== null) {
      depth += s[1] === '/' ? -1 : 1;
      if (depth === 0) return { attrs, inner: markup.slice(start, s.index) };
    }
    // 没有配对的结束标签：把剩下的全当内层，别让整本书读不出来
    return { attrs, inner: markup.slice(start) };
  }
  return null;
}

/** 遇到这些元素直接整块跳过，里面的东西不是正文。 */
const SKIP_ELEMENTS = new Set(['script', 'style', 'head', 'svg', 'math', 'title', 'iframe', 'object']);

/** 这些元素结束一个排版块。 */
const BLOCK_ELEMENTS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li', 'pre',
  'section', 'article', 'aside', 'header', 'footer', 'main', 'nav', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'ul', 'ol', 'dl', 'dd', 'dt',
  'hr', 'address', 'center', 'body', 'html',
]);

/** 自闭合 / 无内容元素，不进栈。 */
const VOID_ELEMENTS = new Set(['br', 'hr', 'img', 'meta', 'link', 'area', 'base', 'col', 'embed', 'input', 'source', 'track', 'wbr', 'image']);

function blockTypeOf(stack: string[]): TextBlock['type'] {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const tag = stack[i]!;
    if (tag === 'pre') return 'code';
    if (/^h[1-6]$/.test(tag)) return (Number(tag[1]) <= 3 ? tag : 'h3') as TextBlock['type'];
    if (tag === 'blockquote') return 'quote';
    if (tag === 'li' || tag === 'dd' || tag === 'dt') return 'li';
  }
  return 'p';
}

export interface XhtmlContent {
  blocks: TextBlock[];
  /** 元素 id / a[name] → 它所在的块下标，用来把目录里的 `#锚点` 落到具体页。 */
  anchors: Map<string, number>;
}

/**
 * 把一份 XHTML 正文压成排版块。
 *
 * 规则刻意保守：只认块级元素的边界与标题 / 引用 / 列表 / 代码这几种语义，
 * 其余标签一律剥掉只留文字 —— 和 Markdown 走的是同一套 `TextBlock`，
 * 于是虚拟滚动、锚点矩形、高亮层、搜索命中层全都能复用。
 */
export function xhtmlToBlocks(xhtml: string): XhtmlContent {
  const blocks: TextBlock[] = [];
  const anchors = new Map<string, number>();
  const stack: string[] = [];
  let pendingAnchors: string[] = [];
  let skipUntil: string | null = null;
  let skipDepth = 0;
  let buf = '';

  const flush = (): void => {
    const inPre = stack.includes('pre');
    const raw = decodeEntities(buf);
    buf = '';
    const text = inPre ? raw.replace(/^\n+|\s+$/g, '') : raw.replace(/\s+/g, ' ').trim();
    if (!text) return;
    for (const id of pendingAnchors) if (!anchors.has(id)) anchors.set(id, blocks.length);
    pendingAnchors = [];
    blocks.push({ type: blockTypeOf(stack), text });
  };

  for (const token of tokenize(xhtml)) {
    if (skipUntil) {
      if (token.type === 'tag' && token.name === skipUntil && !token.selfClosing) {
        if (token.closing) {
          skipDepth -= 1;
          if (skipDepth === 0) skipUntil = null;
        } else skipDepth += 1;
      }
      continue;
    }
    if (token.type === 'text') {
      buf += token.text;
      continue;
    }
    const { name, attrs, closing, selfClosing } = token;
    if (!closing && SKIP_ELEMENTS.has(name)) {
      flush();
      if (!selfClosing) {
        skipUntil = name;
        skipDepth = 1;
      }
      continue;
    }
    if (VOID_ELEMENTS.has(name)) {
      if (name === 'br') buf += stack.includes('pre') ? '\n' : ' ';
      else if (name === 'hr') flush();
      if (!closing && attrs.id) pendingAnchors.push(attrs.id);
      continue;
    }
    if (closing) {
      if (BLOCK_ELEMENTS.has(name)) flush();
      const at = stack.lastIndexOf(name);
      if (at >= 0) stack.length = at;
      continue;
    }
    if (BLOCK_ELEMENTS.has(name)) flush();
    if (attrs.id) pendingAnchors.push(attrs.id);
    if (name === 'a' && attrs.name) pendingAnchors.push(attrs.name);
    if (!selfClosing) stack.push(name);
  }
  flush();
  // 文末还没落地的锚点挂到最后一块上
  for (const id of pendingAnchors) if (!anchors.has(id)) anchors.set(id, Math.max(0, blocks.length - 1));
  return { blocks, anchors };
}
