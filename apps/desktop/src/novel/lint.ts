/**
 * Machine-executable text QC (docs/writing/lexicon/lint-rules.md). Pure; no LLM.
 * Rules: structure (stat), language (regex), AI tells (lexicon), profile negatives.
 */
import { AI_TELLS_ZH, type StyleProfile } from '@the-water/shared';
import { splitParagraphs, splitSentences } from './styleMetrics';
import type { MergedGenre } from './genrePacks';
import { LINT } from './config';

export type LintSeverity = 'block' | 'warn';
export interface LintIssue {
  rule: string;
  severity: LintSeverity;
  message: string;
  /** Code-point offset into the text when the issue is local. */
  offset: number | null;
  length: number;
  quote: string;
}
export interface LintReport {
  issues: LintIssue[];
  /** 0–100, 100 = no AI tells at all. */
  aiTellScore: number;
  stats: { chars: number; sentences: number; paragraphs: number; hardHits: number; softHits: number };
}

export interface LintOptions {
  profile?: StyleProfile | null;
  /** 题材层负面清单（L1，docs/writing/README.md §3.1）。与 L0 词表、作品层 profile 取并集。 */
  genre?: MergedGenre | null;
  /** Skip structural rules (e.g. for very short texts). */
  minCharsForStructure?: number;
}

/** `…` 通配的短语 → 正则（StyleNegatives.avoidPatterns 与题材包共用这个写法）。 */
function phraseToRegExp(p: string): RegExp | null {
  const src = p.split('…').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^，。！？\\n]{0,20}');
  try { return new RegExp(src, 'gu'); } catch { return null; }
}

const perK = (n: number, chars: number) => (chars > 0 ? (n / chars) * 1000 : 0);

function findAll(text: string, needle: string): number[] {
  const out: number[] = [];
  let i = text.indexOf(needle);
  while (i !== -1 && out.length < LINT.maxScanPerNeedle) { out.push(i); i = text.indexOf(needle, i + needle.length); }
  return out;
}

function quoteAt(text: string, offset: number, len: number): string {
  const start = Math.max(0, offset - 12);
  return text.slice(start, Math.min(text.length, offset + len + 12)).replace(/\s+/g, ' ');
}

export function lintText(text: string, opts: LintOptions = {}): LintReport {
  const issues: LintIssue[] = [];
  const chars = Array.from(text.replace(/\s+/g, '')).length;
  const sentences = splitSentences(text);
  const paragraphs = splitParagraphs(text);
  const minStruct = opts.minCharsForStructure ?? LINT.minCharsForStructure;
  let hardHits = 0;
  let softHits = 0;

  // ---- AI tells: hard words ----
  for (const w of AI_TELLS_ZH.words) {
    const hits = findAll(text, w);
    if (hits.length === 0) continue;
    hardHits += hits.length;
    for (const h of hits.slice(0, LINT.maxHitsPerRule)) issues.push({ rule: 'ai-word-hard', severity: perK(hits.length, chars) > 1 ? 'block' : 'warn', message: `AI 味用词「${w}」`, offset: h, length: w.length, quote: quoteAt(text, h, w.length) });
  }
  // ---- AI tells: soft words over limit ----
  const softLimit = AI_TELLS_ZH.wordsSoft.limitPerK;
  for (const w of AI_TELLS_ZH.wordsSoft.list) {
    const hits = findAll(text, w);
    softHits += hits.length;
    if (hits.length > 0 && perK(hits.length, chars) > softLimit) {
      issues.push({ rule: 'ai-word-soft', severity: 'warn', message: `「${w}」用得太多（${hits.length} 次，每千字上限 ${softLimit}）`, offset: hits[0]!, length: w.length, quote: quoteAt(text, hits[0]!, w.length) });
    }
  }
  // ---- AI tells: patterns ----
  for (const p of AI_TELLS_ZH.patterns) {
    let re: RegExp;
    try { re = new RegExp(p.regex, 'gmu'); } catch { continue; }
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(text)) !== null && n < LINT.maxHitsPerRule) {
      n++;
      issues.push({ rule: `ai-pattern:${p.id}`, severity: 'warn', message: `套话句式：${p.note}`, offset: m.index, length: m[0].length, quote: quoteAt(text, m.index, m[0].length) });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  // ---- genre negatives (L1) ----
  const genre = opts.genre;
  const genreWords = new Set<string>();
  if (genre && genre.packIds.length > 0) {
    const label = genre.labels.join('/');
    for (const w of genre.forbiddenWords) {
      genreWords.add(w);
      const hits = findAll(text, w);
      for (const h of hits.slice(0, LINT.maxHitsPerRule)) issues.push({ rule: 'genre-avoid-word', severity: 'block', message: `${label}题材里不用「${w}」`, offset: h, length: w.length, quote: quoteAt(text, h, w.length) });
    }
    for (const w of genre.softWords) {
      genreWords.add(w);
      const hits = findAll(text, w);
      if (hits.length > 0 && perK(hits.length, chars) > softLimit) {
        issues.push({ rule: 'genre-avoid-word-soft', severity: 'warn', message: `「${w}」用得太多（${hits.length} 次，${label}题材每千字上限 ${softLimit}）`, offset: hits[0]!, length: w.length, quote: quoteAt(text, hits[0]!, w.length) });
      }
    }
    for (const p of genre.forbiddenPatterns) {
      const re = phraseToRegExp(p);
      if (!re) continue;
      let m: RegExpExecArray | null;
      let n = 0;
      while ((m = re.exec(text)) !== null && n < LINT.maxHitsPerRule) {
        n++;
        issues.push({ rule: 'genre-avoid-pattern', severity: 'warn', message: `${label}题材避免的句式：${p}`, offset: m.index, length: m[0].length, quote: quoteAt(text, m.index, m[0].length) });
        if (m[0].length === 0) re.lastIndex++;
      }
    }
  }

  // ---- profile negatives (L2, 覆盖同词的题材层报告) ----
  const prof = opts.profile;
  if (prof) {
    for (const w of prof.negatives.avoidWords) {
      if (genreWords.has(w)) continue;
      const hits = findAll(text, w);
      for (const h of hits.slice(0, LINT.maxHitsPerRule)) issues.push({ rule: 'profile-avoid-word', severity: 'block', message: `这本书里不用「${w}」`, offset: h, length: w.length, quote: quoteAt(text, h, w.length) });
    }
    for (const w of prof.negatives.avoidWordsSoft.list) {
      if (genreWords.has(w)) continue;
      const hits = findAll(text, w);
      if (hits.length > 0 && perK(hits.length, chars) > prof.negatives.avoidWordsSoft.limitPerK) {
        issues.push({ rule: 'profile-avoid-word-soft', severity: 'warn', message: `「${w}」超过这本书的用量上限（${hits.length} 次）`, offset: hits[0]!, length: w.length, quote: quoteAt(text, hits[0]!, w.length) });
      }
    }
    for (const p of prof.negatives.avoidPatterns) {
      if (!p.trim()) continue;
      // patterns are written as plain phrases or with … as a wildcard
      const re = phraseToRegExp(p);
      if (!re) continue;
      let m: RegExpExecArray | null;
      let n = 0;
      while ((m = re.exec(text)) !== null && n < LINT.maxHitsPerRule) {
        n++;
        issues.push({ rule: 'profile-avoid-pattern', severity: 'warn', message: `这本书避免的句式：${p}`, offset: m.index, length: m[0].length, quote: quoteAt(text, m.index, m[0].length) });
        if (m[0].length === 0) re.lastIndex++;
      }
    }
  }

  // ---- language: 的字连用 / repeated words within paragraph ----
  for (const para of paragraphs) {
    const cps = Array.from(para.replace(/[，。！？、；：“”‘’「」\s]/g, ''));
    const counts = new Map<string, number>();
    for (let i = 0; i + 2 <= cps.length; i++) {
      const g = cps.slice(i, i + 2).join('');
      if (!/^\p{Script=Han}{2}$/u.test(g) || /[的了着过是不在有他她它我你]/.test(g)) continue;
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    for (const [g, c] of counts) {
      if (c >= LINT.wordRepeatMin && Array.from(para).length < LINT.wordRepeatParaMax) {
        const off = text.indexOf(para);
        issues.push({ rule: 'word-repeat', severity: 'warn', message: `同一段里「${g}」重复了 ${c} 次`, offset: off >= 0 ? off : null, length: 0, quote: g });
        break;
      }
    }
  }

  // ---- structure ----
  if (chars >= minStruct) {
    const sl = sentences.map((s) => Array.from(s).length);
    if (sl.length >= LINT.minSentencesForBurstiness) {
      const mean = sl.reduce((a, b) => a + b, 0) / sl.length;
      const sd = Math.sqrt(sl.reduce((a, b) => a + (b - mean) ** 2, 0) / sl.length);
      if (mean > 0 && sd / mean < LINT.burstinessWarn) issues.push({ rule: 'low-burstiness', severity: 'warn', message: `句长过于均一（起伏 ${(sd / mean).toFixed(2)}），像机器写的；让长短句交错`, offset: null, length: 0, quote: '' });
    }
    const pl = paragraphs.map((p) => Array.from(p).length);
    if (pl.length >= LINT.minParagraphsForUniformity) {
      const mean = pl.reduce((a, b) => a + b, 0) / pl.length;
      const sd = Math.sqrt(pl.reduce((a, b) => a + (b - mean) ** 2, 0) / pl.length);
      if (mean > 0 && sd / mean < LINT.paragraphUniformWarn) issues.push({ rule: 'uniform-paragraphs', severity: 'warn', message: '每段长度几乎一样，过于工整', offset: null, length: 0, quote: '' });
    }
    const headed = paragraphs.filter((p) => /^(\*\*.{1,12}\*\*|[^，。！？\n]{1,10}[：:])/.test(p)).length;
    if (paragraphs.length >= 4 && headed / paragraphs.length >= LINT.headedParagraphRatio) issues.push({ rule: 'heading-every-para', severity: 'warn', message: '段段都是小标题式开头', offset: null, length: 0, quote: '' });
    if ((text.match(/[✅❌💡🚀✨🔥📌]/gu) ?? []).length >= LINT.emojiBulletMin) issues.push({ rule: 'emoji-bullets', severity: 'warn', message: '出现了 emoji 列表符号', offset: null, length: 0, quote: '' });
    const last = paragraphs.at(-1) ?? '';
    if (/(总之|归根结底|综上所述|真正重要的是|让我们|未来.{0,6}(可期|光明))/u.test(last)) issues.push({ rule: 'hollow-ending', severity: 'warn', message: '结尾像总结陈词', offset: text.lastIndexOf(last), length: last.length, quote: last.slice(0, 40) });
  }

  const tellRate = perK(hardHits * 2 + softHits + issues.filter((i) => i.rule.startsWith('ai-pattern')).length * 2, chars);
  const aiTellScore = Math.max(0, Math.round(100 - tellRate * LINT.aiTellPenaltyPerK));
  return { issues, aiTellScore, stats: { chars, sentences: sentences.length, paragraphs: paragraphs.length, hardHits, softHits } };
}

/** Compact issue lines for feeding a revision prompt. */
export function lintIssuesToInstructions(report: LintReport, max: number = LINT.maxInstructions): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of [...report.issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'block' ? -1 : 1))) {
    const key = i.message;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(i.quote ? `${i.message}（如：「${i.quote}」）` : i.message);
    if (out.length >= max) break;
  }
  return out;
}
