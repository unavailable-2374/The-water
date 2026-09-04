/**
 * 文字层 DOM ↔ 规范化页文本 的偏移映射。
 * 搜索命中高亮与高亮锚点重定位后重算矩形都靠它：先把 DOM 里的文本节点拼成
 * 与 normalizePageText 同口径的字符串，同时记住每个字符来自哪个节点的哪一位。
 */

export interface TextChunk {
  /** 文本节点；换行占位（<br>）为 null */
  node: Text | null;
  text: string;
}

export interface MapEntry {
  chunk: number;
  offset: number;
}

export interface TextMap {
  text: string;
  entries: MapEntry[];
  chunks: TextChunk[];
}

/** 纯逻辑：把若干文本片段拼成规范化文本，并记录每个字符的来源。 */
export function buildTextMap(chunks: TextChunk[]): TextMap {
  const entries: MapEntry[] = [];
  let text = '';
  chunks.forEach((chunk, ci) => {
    for (let i = 0; i < chunk.text.length; i++) {
      const raw = chunk.text[i]!;
      if (/\s/.test(raw)) {
        if (text.length === 0 || text.endsWith(' ')) continue;
        text += ' ';
        entries.push({ chunk: ci, offset: i });
        continue;
      }
      const norm = raw.normalize('NFKC');
      for (let k = 0; k < norm.length; k++) {
        text += norm[k];
        entries.push({ chunk: ci, offset: i });
      }
    }
  });
  while (text.endsWith(' ')) {
    text = text.slice(0, -1);
    entries.pop();
  }
  return { text, entries, chunks };
}

export interface DomSpan {
  startNode: Text;
  startOffset: number;
  endNode: Text;
  endOffset: number;
}

/** 把规范化文本上的 [start, end) 还原成 DOM 里的一段范围；落不到文本节点上时返回 null。 */
export function spanToDom(map: TextMap, start: number, end: number): DomSpan | null {
  if (start < 0 || end <= start || end > map.entries.length) return null;
  const head = firstTextEntry(map, start, end, 1);
  const tail = firstTextEntry(map, end - 1, start - 1, -1);
  if (!head || !tail) return null;
  const startNode = map.chunks[head.chunk]!.node!;
  const endNode = map.chunks[tail.chunk]!.node!;
  return { startNode, startOffset: head.offset, endNode, endOffset: tail.offset + 1 };
}

function firstTextEntry(map: TextMap, from: number, stop: number, step: number): MapEntry | null {
  for (let i = from; step > 0 ? i < stop : i > stop; i += step) {
    const e = map.entries[i];
    if (e && map.chunks[e.chunk]?.node) return e;
  }
  return null;
}

/** 反向：DOM 里的一个位置 → 规范化文本上的偏移；找不到返回 -1。 */
export function offsetOfDomPoint(map: TextMap, node: Node, offset: number, side: 'start' | 'end'): number {
  const chunk = map.chunks.findIndex((c) => c.node === node);
  if (chunk === -1) return -1;
  if (side === 'start') {
    for (let i = 0; i < map.entries.length; i++) {
      const e = map.entries[i]!;
      if (e.chunk === chunk && e.offset >= offset) return i;
      if (e.chunk > chunk) return i;
    }
    return map.entries.length;
  }
  for (let i = map.entries.length - 1; i >= 0; i--) {
    const e = map.entries[i]!;
    if (e.chunk === chunk && e.offset < offset) return i + 1;
    if (e.chunk < chunk) return i + 1;
  }
  return 0;
}

/** 从容器里收集文本片段：文本节点原样，<br> 记成换行。 */
export function collectChunks(container: Node): TextChunk[] {
  const chunks: TextChunk[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      chunks.push({ node: node as Text, text: node.nodeValue ?? '' });
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'BR') {
      chunks.push({ node: null, text: '\n' });
      return;
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(container);
  return chunks;
}

/** 容器的规范化文本 + 映射。 */
export function mapContainer(container: Node): TextMap {
  return buildTextMap(collectChunks(container));
}
