/**
 * 文本 diff（§2.2 第 2 条）。纯函数，不引依赖。
 *
 * 选型：**两级 LCS**。
 * 先按行（段落）做一次最长公共子序列，再把相邻的「删一段 + 加一段」下钻到句级
 * 重新对齐。中文小说的段落通常很长，只做行级 diff 会把「改了两个字的一段」整段
 * 标成删除 + 新增，读不出改了什么；只做句级 diff 又会让整章几百个句子一起进 DP，
 * 既慢又容易把不相干的句子配上对。两级的好处是 DP 规模始终很小（行级几十到
 * 几百；句级只在变动块内部跑），而输出粒度是句子。
 *
 * 切分是**无损**的：换行留在行末、句末标点留在句末，片段直接相接就是原文。
 * 所以 equal + delete 拼起来一定等于旧文，equal + insert 拼起来一定等于新文
 * （有测试兜底）。
 *
 * DP 只存方向表（每格 1 字节），长度用滚动两行，所以 2000×2000 的块也只要 4MB。
 * 超过 MAX_DP_CELLS 的块不硬算，退化成「整块删 + 整块加」——那种规模已经不是
 * 「改了几句」而是「换了一篇」，逐句对齐也没有阅读价值。
 */

export type DiffOpType = 'equal' | 'insert' | 'delete';
export type DiffGranularity = 'line' | 'sentence';

export interface DiffOp {
  type: DiffOpType;
  text: string;
}

/** DP 方向表的上限（格数）。超过就不逐段对齐了。 */
export const MAX_DP_CELLS = 4_000_000;

/** 行切分：换行留在行末，片段相接即原文。 */
export function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** 句末标点：中英文句末标点 + 收尾的引号书名号，连续出现算一处。 */
const SENTENCE_END = /[。！？!?…；;]+[」』”’"'）)】》]*/y;

/**
 * 句切分：句末标点与换行都留在片段末尾，片段相接即原文。
 * 没有标点的长句不再细分——中文里那通常就是一整句。
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      out.push(text.slice(start, i + 1));
      start = i + 1;
      continue;
    }
    SENTENCE_END.lastIndex = i;
    if (!SENTENCE_END.exec(text)) continue;
    let end = SENTENCE_END.lastIndex;
    // 标点后面紧跟换行时把换行一起带走，免得切出只有 '\n' 的碎片。
    if (text[end] === '\n') end++;
    out.push(text.slice(start, end));
    start = end;
    i = end - 1;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

const push = (ops: DiffOp[], type: DiffOpType, text: string): void => {
  if (!text) return;
  const last = ops[ops.length - 1];
  if (last && last.type === type) last.text += text;
  else ops.push({ type, text });
};

/** 片段序列的 LCS diff；同类型的相邻段会合并。片段自带分隔符，直接相接即原文。 */
export function diffSegments(a: readonly string[], b: readonly string[]): DiffOp[] {
  const ops: DiffOp[] = [];

  // 先剥掉公共前后缀，DP 只处理中间真正不同的部分。
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let hiA = a.length;
  let hiB = b.length;
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) { hiA--; hiB--; }

  push(ops, 'equal', a.slice(0, lo).join(''));

  const midA = a.slice(lo, hiA);
  const midB = b.slice(lo, hiB);
  const n = midA.length;
  const m = midB.length;

  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_DP_CELLS) {
    push(ops, 'delete', midA.join(''));
    push(ops, 'insert', midB.join(''));
  } else {
    // 方向表：1 = 对角（相同）、2 = 上（删 a[i]）、3 = 左（加 b[j]）。
    const dir = new Uint8Array((n + 1) * (m + 1));
    let prev = new Uint32Array(m + 1);
    let cur = new Uint32Array(m + 1);
    for (let i = 1; i <= n; i++) {
      const row = i * (m + 1);
      for (let j = 1; j <= m; j++) {
        if (midA[i - 1] === midB[j - 1]) {
          cur[j] = prev[j - 1]! + 1;
          dir[row + j] = 1;
        } else if (prev[j]! > cur[j - 1]!) {
          // 打平时偏向「左」（新增）。回溯是倒着走的，倒着先取新增，正着读回来
          // 就是「先删后加」——这是 diff 的惯例顺序，refineOps 也靠它成对配上。
          cur[j] = prev[j]!;
          dir[row + j] = 2;
        } else {
          cur[j] = cur[j - 1]!;
          dir[row + j] = 3;
        }
      }
      const swap = prev;
      prev = cur;
      cur = swap;
      cur.fill(0);
    }
    // 回溯出编辑脚本（从末尾往回走，所以要倒着读回来）。
    const rev: DiffOp[] = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && dir[i * (m + 1) + j] === 1) { rev.push({ type: 'equal', text: midA[i - 1]! }); i--; j--; }
      else if (j > 0 && (i === 0 || dir[i * (m + 1) + j] === 3)) { rev.push({ type: 'insert', text: midB[j - 1]! }); j--; }
      else { rev.push({ type: 'delete', text: midA[i - 1]! }); i--; }
    }
    for (let k = rev.length - 1; k >= 0; k--) push(ops, rev[k]!.type, rev[k]!.text);
  }

  push(ops, 'equal', a.slice(hiA).join(''));
  return ops;
}

/** 相邻的「删 + 加」下钻到句级重新对齐；其余原样保留。 */
export function refineOps(ops: readonly DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  for (let i = 0; i < ops.length; i++) {
    const a = ops[i]!;
    const b = ops[i + 1];
    const pair = a.type === 'delete' && b?.type === 'insert' ? { del: a, ins: b } : a.type === 'insert' && b?.type === 'delete' ? { del: b, ins: a } : null;
    if (pair) {
      for (const op of diffSegments(splitSentences(pair.del.text), splitSentences(pair.ins.text))) push(out, op.type, op.text);
      i++;
      continue;
    }
    push(out, a.type, a.text);
  }
  return out;
}

export interface DiffTextOptions {
  /** 第一级切分的粒度，默认按行。 */
  granularity?: DiffGranularity;
  /** 是否把变动块下钻到句级，默认 true（granularity 为 sentence 时无意义）。 */
  refine?: boolean;
}

/** 旧文 → 新文的 diff。 */
export function diffText(oldText: string, newText: string, opts: DiffTextOptions = {}): DiffOp[] {
  const granularity = opts.granularity ?? 'line';
  if (oldText === newText) return oldText ? [{ type: 'equal', text: oldText }] : [];
  const ops =
    granularity === 'sentence'
      ? diffSegments(splitSentences(oldText), splitSentences(newText))
      : diffSegments(splitLines(oldText), splitLines(newText));
  return granularity === 'line' && opts.refine !== false ? refineOps(ops) : ops;
}

export interface DiffStats {
  /** 新增的字符数。 */
  added: number;
  /** 删除的字符数。 */
  removed: number;
  /** 两边都有的字符数。 */
  unchanged: number;
  /** 变动块数（连续的删 / 加算一块）。 */
  blocks: number;
}

export function diffStats(ops: readonly DiffOp[]): DiffStats {
  const stats: DiffStats = { added: 0, removed: 0, unchanged: 0, blocks: 0 };
  let inBlock = false;
  for (const op of ops) {
    if (op.type === 'equal') { stats.unchanged += op.text.length; inBlock = false; continue; }
    if (op.type === 'insert') stats.added += op.text.length;
    else stats.removed += op.text.length;
    if (!inBlock) { stats.blocks++; inBlock = true; }
  }
  return stats;
}

/** 一行人话的变动摘要。 */
export function summarizeTextDiff(ops: readonly DiffOp[]): string {
  const s = diffStats(ops);
  if (s.added === 0 && s.removed === 0) return '两稿正文完全一样';
  const parts: string[] = [];
  if (s.added) parts.push(`新增 ${s.added.toLocaleString()} 字`);
  if (s.removed) parts.push(`删除 ${s.removed.toLocaleString()} 字`);
  return `${parts.join(' · ')} · 共 ${s.blocks} 处改动`;
}

/** 只取旧文一侧（equal + delete）或新文一侧（equal + insert）。 */
export function sideOf(ops: readonly DiffOp[], side: 'old' | 'new'): DiffOp[] {
  const drop: DiffOpType = side === 'old' ? 'insert' : 'delete';
  return ops.filter((o) => o.type !== drop);
}
