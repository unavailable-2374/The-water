import { z } from 'zod';
import { anchorEvidence } from '@the-water/shared';

/** Models supply quotations; the application computes authoritative UTF-16 offsets. */
export const ModelEvidenceSchema = z.object({
  quote: z.string().min(1).max(4000),
  // Optional hints retain compatibility and can disambiguate repeated quotes only after exact verification.
  from: z.number().int().optional(),
  to: z.number().int().optional(),
});
export function locateModelEvidence(source: string, evidence: z.infer<typeof ModelEvidenceSchema>) {
  return anchorEvidence(source, {
    from: evidence.from ?? -1,
    to: evidence.to ?? -1,
    quote: evidence.quote,
  });
}

export interface ProseEvidenceSpan { id: string; from: number; to: number; text: string }

/** Lossless sentence/line index: model citations select source bytes, never recopy them. */
export function indexProseEvidence(source: string): ProseEvidenceSpan[] {
  const spans: ProseEvidenceSpan[] = [];
  for (const match of source.matchAll(/[\s\S]*?(?:[。！？]+[”’"']*|\r?\n+|$)/gu)) {
    if (!match[0]) continue;
    let from = match.index;
    const to = from + match[0].length;
    while (from < to) {
      let end = Math.min(to, from + 1000);
      if (end < to && /[\uD800-\uDBFF]/u.test(source[end - 1]!)) end--;
      spans.push({ id: `s${spans.length + 1}`, from, to: end, text: source.slice(from, end) });
      from = end;
    }
  }
  if (spans.map(s => s.text).join('') !== source) throw new Error('原文证据索引未完整保留正文');
  return spans;
}

export function indexedEvidenceSchema(spans: ProseEvidenceSpan[]) {
  if (!spans.length) throw new Error('正文为空，不能建立事实证据索引');
  const id = z.enum(spans.map(s => s.id) as [string, ...string[]]);
  return z.object({ startSpan: id, endSpan: id });
}

export function locateIndexedEvidence(source: string, spans: ProseEvidenceSpan[], evidence: { startSpan: string; endSpan: string }) {
  const start = spans.find(s => s.id === evidence.startSpan), end = spans.find(s => s.id === evidence.endSpan);
  if (!start || !end) throw new Error('证据片段编号不在当前正文索引中');
  if (end.from < start.from) throw new Error('endSpan 必须在 startSpan 之后或与其相同');
  const quote = source.slice(start.from, end.to);
  if (!quote.trim() || quote.length > 4000) throw new Error('证据范围必须含实质原文且不超过 4000 UTF-16 字符，请选择更精确的连续片段');
  const selected = spans.filter(s => s.from >= start.from && s.to <= end.to);
  if (selected.map(s => s.text).join('') !== quote || selected.some(s => source.slice(s.from, s.to) !== s.text))
    throw new Error('证据索引与当前正文不一致，必须重新建立索引');
  return anchorEvidence(source, { from: start.from, to: end.to, quote });
}
