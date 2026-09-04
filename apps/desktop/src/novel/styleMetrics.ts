/**
 * Local (no-LLM) stylometry for Chinese prose — docs/writing/README.md §4.1.
 * Everything is counted in code points; sentences split on 。！？…; paragraphs on blank lines / newlines.
 */
import type { StyleMetrics, StyleTargets } from '@the-water/shared';
import { STYLE_METRICS } from './config';

const FUNCTION_WORDS = ['的', '了', '着', '过', '吗', '呢', '啊', '吧', '却', '便', '竟', '只', '就', '也', '都', '又', '还', '仿佛', '似乎'] as const;
const PUNCT: Array<[string, RegExp]> = [
  ['。', /。/g], ['，', /，/g], ['！', /！|!/g], ['？', /？|\?/g], ['……', /……|…|\.{3,}/g], ['——', /——|—/g], ['、', /、/g], ['；', /；/g], ['：', /：/g],
];
/** Common bigrams that carry no style signal. */
const NGRAM_STOP = new Set(['自己', '一个', '什么', '没有', '这个', '那个', '他们', '我们', '你们', '知道', '已经', '可以', '这样', '那样', '不是', '就是', '还是', '时候', '一下', '一样', '起来', '出来', '过去', '现在', '所以', '因为', '但是', '虽然', '如果', '然后', '这里', '那里', '之后', '之前', '这么', '那么', '怎么', '不能', '不会', '不要', '一直', '一点', '一些', '有些', '有点', '看着', '说道', '问道']);

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[。！？!?…])["”’」』]?\s*/u)
    .map((s) => s.replace(/[。！？!?…"“”‘’「」『』\s]/g, ''))
    .filter((s) => s.length >= 2);
}

export function splitParagraphs(text: string): string[] {
  return text.split(/\n\s*\n|\n/).map((p) => p.trim()).filter((p) => p.length > 0);
}

function stats(xs: number[]): { mean: number; sd: number; p10: number; p90: number } {
  if (xs.length === 0) return { mean: 0, sd: 0, p10: 0, p90: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  const sorted = [...xs].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  return { mean: r2(mean), sd: r2(sd), p10: q(0.1), p90: q(0.9) };
}
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Characters inside “…” / "…" / 「…」 pairs. */
export function dialogueChars(text: string): number {
  let n = 0;
  const re = /[“"「『]([^”"」』]{1,400})[”"」』]/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) n += Array.from(m[1]!.replace(/\s+/g, '')).length;
  return n;
}

export function ngramSignature(text: string, top: number = STYLE_METRICS.ngramTop): string[] {
  const clean = text.replace(/[^\p{Script=Han}]+/gu, ' ');
  const counts = new Map<string, number>();
  for (const run of clean.split(' ')) {
    const cps = Array.from(run);
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= cps.length; i++) {
        const g = cps.slice(i, i + n).join('');
        if (n === 2 && (NGRAM_STOP.has(g) || FUNCTION_WORDS.some((w) => g.includes(w)))) continue;
        if (n === 3 && FUNCTION_WORDS.some((w) => g.includes(w))) continue;
        counts.set(g, (counts.get(g) ?? 0) + 1);
      }
    }
  }
  const total = Math.max(1, Array.from(clean.replace(/\s/g, '')).length);
  return [...counts.entries()]
    .filter(([, c]) => c >= STYLE_METRICS.ngramMinCount && c / total > STYLE_METRICS.ngramMinRatio)
    .sort((a, b) => b[1] * b[0].length - a[1] * a[0].length)
    .slice(0, top)
    .map(([g]) => g);
}

/** Compute metrics over one or more chapter texts. */
export function computeStyleMetrics(texts: readonly string[]): StyleMetrics {
  const all = texts.join('\n\n');
  const chars = Array.from(all.replace(/\s+/g, '')).length;
  const sentences = texts.flatMap(splitSentences);
  const sentLens = sentences.map((s) => Array.from(s).length);
  const paragraphs = texts.flatMap(splitParagraphs);
  const paraLens = paragraphs.map((p) => Array.from(p.replace(/\s+/g, '')).length);
  const single = paragraphs.filter((p) => splitSentences(p).length <= 1).length;
  const sl = stats(sentLens);
  const pl = stats(paraLens);
  const perK = (n: number) => (chars > 0 ? r2((n / chars) * 1000) : 0);
  const punctuationPerK: Record<string, number> = {};
  for (const [label, re] of PUNCT) punctuationPerK[label] = perK((all.match(re) ?? []).length);
  const functionWordsPerK: Record<string, number> = {};
  for (const w of FUNCTION_WORDS) functionWordsPerK[w] = perK(all.split(w).length - 1);
  return {
    sampledChars: chars,
    sentenceLength: sl,
    burstiness: sl.mean > 0 ? r2(sl.sd / sl.mean) : 0,
    paragraphLength: { mean: pl.mean, sd: pl.sd, singleSentenceRatio: paragraphs.length ? r2(single / paragraphs.length) : 0 },
    dialogueRatio: chars > 0 ? r2(dialogueChars(all) / chars) : 0,
    punctuationPerK,
    functionWordsPerK,
    ngramSignature: ngramSignature(all),
  };
}

export interface MetricFinding {
  key: keyof Omit<StyleTargets, 'hard'>;
  label: string;
  value: number;
  target: [number, number];
  hard: boolean;
  /** Relative distance outside the band (0 = inside). */
  deviation: number;
  hint: string;
}
export interface MetricComparison {
  score: number;
  findings: MetricFinding[];
  hardViolations: MetricFinding[];
}

const LABEL: Record<MetricFinding['key'], string> = {
  sentenceMean: '平均句长', burstiness: '句长起伏', paragraphMean: '平均段长', dialogueRatio: '对白占比', exclamationPerK: '感叹号密度', ellipsisPerK: '省略号密度',
};

function hintFor(key: MetricFinding['key'], value: number, [lo, hi]: [number, number]): string {
  const low = value < lo;
  switch (key) {
    case 'sentenceMean': return low ? `句子偏短（${value} 字），原著多在 ${lo}–${hi} 字，可把部分短句合并` : `句子偏长（${value} 字），原著多在 ${lo}–${hi} 字，把长句拆开`;
    case 'burstiness': return low ? '句长过于均一，缺少长短交错' : '句长起伏过大，节奏散';
    case 'paragraphMean': return low ? `段落偏碎（均 ${value} 字）` : `段落偏长（均 ${value} 字），在动作完成处断段`;
    case 'dialogueRatio': return low ? '对白偏少' : '对白偏多';
    case 'exclamationPerK': return '感叹号过多';
    case 'ellipsisPerK': return '省略号过多';
  }
}

/** Compare measured metrics with a profile's targets. Score 100 = every checked metric inside its band. */
export function compareMetrics(m: StyleMetrics, t: StyleTargets): MetricComparison {
  const values: Record<MetricFinding['key'], number> = {
    sentenceMean: m.sentenceLength.mean,
    burstiness: m.burstiness,
    paragraphMean: m.paragraphLength.mean,
    dialogueRatio: m.dialogueRatio,
    exclamationPerK: m.punctuationPerK['！'] ?? 0,
    ellipsisPerK: m.punctuationPerK['……'] ?? 0,
  };
  const findings: MetricFinding[] = [];
  let checked = 0;
  let penalty = 0;
  for (const key of Object.keys(values) as MetricFinding['key'][]) {
    const target = t[key];
    if (!target) continue;
    checked++;
    const value = values[key];
    const [lo, hi] = target;
    let deviation = 0;
    if (value < lo) deviation = lo > 0 ? (lo - value) / lo : 1;
    else if (value > hi) deviation = hi > 0 ? (value - hi) / hi : 1;
    if (deviation <= 0) continue;
    const hard = t.hard.includes(key);
    findings.push({ key, label: LABEL[key], value, target, hard, deviation: r2(deviation), hint: hintFor(key, value, target) });
    penalty += Math.min(1, deviation) * (hard ? STYLE_METRICS.hardMetricWeight : 1);
  }
  const score = checked === 0 ? 100 : Math.max(0, Math.round(100 - (penalty / checked) * 100));
  return { score, findings, hardViolations: findings.filter((f) => f.hard) };
}

/** Rough scene-type guess for picking exemplars (no LLM). */
export function guessSceneType(text: string): 'fight' | 'dialogue' | 'quiet' | 'other' {
  const chars = Math.max(1, Array.from(text.replace(/\s+/g, '')).length);
  const dialogue = dialogueChars(text) / chars;
  const action = (text.match(/[刀剑枪拳掌击打杀砍劈冲扑闪撞血战斗]/g) ?? []).length / chars;
  if (dialogue > STYLE_METRICS.dialogueSceneRatio) return 'dialogue';
  if (action > STYLE_METRICS.fightSceneRatio) return 'fight';
  if (dialogue < STYLE_METRICS.quietSceneRatio) return 'quiet';
  return 'other';
}
