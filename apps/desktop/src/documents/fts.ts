/**
 * 中文可用的 FTS5 方案：unicode61 分词器 + 二元切分（bigram）。
 *
 * SQLite 自带的分词器里，unicode61 把一整串汉字当成一个词，trigram 又要求查询至少 3 个字，
 * 中文里最常见的双字词就搜不到。所以入库前先由我们自己做二元切分：
 *   「中国人民」 → 「中国 国人 人民 民」
 * 查询时做同样的切分并拼成短语查询：
 *   「国人民」 → '"国人 人民"'
 * 短语查询要求这些 bigram 在文档里连续出现，等价于子串匹配，不会有二元切分常见的假命中。
 * 入库时额外补一个「末字」单字 token，保证任何单字查询都能作为某个 token 的前缀命中。
 */

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;
const WORD = /[0-9A-Za-z_À-ɏ]/;

export function isCjk(ch: string): boolean {
  return CJK.test(ch);
}

type Run = { cjk: boolean; text: string };

/** 把文本切成「连续汉字块」与「连续西文/数字块」，其余字符（标点、空白）丢弃。 */
export function splitRuns(text: string): Run[] {
  const runs: Run[] = [];
  let cur: Run | null = null;
  for (const ch of text.normalize('NFKC')) {
    const cjk = CJK.test(ch);
    const word = !cjk && WORD.test(ch);
    if (!cjk && !word) {
      cur = null;
      continue;
    }
    if (!cur || cur.cjk !== cjk) {
      cur = { cjk, text: '' };
      runs.push(cur);
    }
    cur.text += cjk ? ch : ch.toLowerCase();
  }
  return runs;
}

/** 生成入库用的 token 串（写进 FTS 表的 body 列）。 */
export function ftsIndexText(text: string): string {
  const out: string[] = [];
  for (const run of splitRuns(text)) {
    if (!run.cjk) {
      out.push(run.text);
      continue;
    }
    const chars = [...run.text];
    if (chars.length === 1) {
      out.push(chars[0]!);
      continue;
    }
    for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
    out.push(chars[chars.length - 1]!);
  }
  return out.join(' ');
}

/**
 * 生成 MATCH 表达式；查询里没有可用字符时返回 null（调用方据此不查）。
 */
export function ftsMatchQuery(q: string): string | null {
  const parts: string[] = [];
  for (const run of splitRuns(q)) {
    if (!run.cjk) {
      parts.push(`"${run.text}"`);
      continue;
    }
    const chars = [...run.text];
    if (chars.length === 1) {
      // 单字查询走前缀匹配：bigram token 的首字即可命中
      parts.push(`"${chars[0]}"*`);
      continue;
    }
    const grams: string[] = [];
    for (let i = 0; i + 1 < chars.length; i++) grams.push(chars[i]! + chars[i + 1]!);
    parts.push(`"${grams.join(' ')}"`);
  }
  if (parts.length === 0) return null;
  return parts.join(' AND ');
}

export interface TextMatch {
  start: number;
  end: number;
  snippet: string;
  /** 命中片段在 snippet 中的偏移，用于给结果条目做高亮 */
  snippetStart: number;
  snippetEnd: number;
}

const SNIPPET_CTX = 28;

/**
 * 在一页文本里找出全部命中（大小写不敏感）。搜索面板的计数、片段与上一条/下一条都基于它。
 */
export function findMatches(pageText: string, q: string, limit = 200): TextMatch[] {
  const needle = q.normalize('NFKC').trim().toLowerCase();
  if (!needle) return [];
  const hay = pageText.normalize('NFKC').toLowerCase();
  const out: TextMatch[] = [];
  let i = hay.indexOf(needle);
  while (i !== -1 && out.length < limit) {
    const s = Math.max(0, i - SNIPPET_CTX);
    const e = Math.min(pageText.length, i + needle.length + SNIPPET_CTX);
    out.push({
      start: i,
      end: i + needle.length,
      snippet: pageText.slice(s, e),
      snippetStart: i - s,
      snippetEnd: i - s + needle.length,
    });
    i = hay.indexOf(needle, i + needle.length);
  }
  return out;
}
