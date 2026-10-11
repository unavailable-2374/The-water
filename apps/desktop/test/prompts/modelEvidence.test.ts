/** TEST strings validate source anchoring, not literary quality. */
import { expect, it } from 'vitest';
import { ModelEvidenceSchema, locateModelEvidence, indexProseEvidence, indexedEvidenceSchema, locateIndexedEvidence } from '@/llm/prompts/evidence';
import { EvidenceSchema } from '@the-water/shared';

it('TEST invalid model positions are replaced with exact UTF-16 source positions', () => {
  const source = 'TEST 📨：核对邮戳后交还信封。';
  const quote = '核对邮戳后交还信封';
  const model = ModelEvidenceSchema.parse({ quote, from: 0, to: 0 });
  const evidence = locateModelEvidence(source, model);
  expect(evidence).toEqual({ quote, from: 8, to: 17 });
  expect(EvidenceSchema.safeParse(evidence).success).toBe(true);
  expect(EvidenceSchema.safeParse({ quote, from: 0, to: 0 }).success).toBe(false);
});
it('TEST verified optional positions disambiguate repeated quotes', () => {
  expect(locateModelEvidence('TEST 重复。重复。', { quote: '重复', from: 8, to: 10 })).toEqual({
    quote: '重复',
    from: 8,
    to: 10,
  });
});
it('TEST invented and ambiguous model quotes are rejected', () => {
  expect(() => locateModelEvidence('TEST 真实原文', { quote: 'TEST 编造引文' })).toThrow(
    'missing or ambiguous',
  );
  expect(() => locateModelEvidence('TEST 重复。重复。', { quote: '重复' })).toThrow(
    'missing or ambiguous',
  );
});

it('TEST indexed evidence preserves every source byte, including CRLF, blank lines, quotes and emoji', () => {
  const source='TEST 😀门开了。\r\n\r\n“我知道。”\n\n“我知道。”他答。  ';
  const spans=indexProseEvidence(source);
  expect(spans.map(s=>s.text).join('')).toBe(source);
  for(const span of spans)expect(source.slice(span.from,span.to)).toBe(span.text);
  const first=spans.find(s=>s.text==='“我知道。”')!;
  const evidence=locateIndexedEvidence(source,spans,{startSpan:first.id,endSpan:first.id});
  expect(evidence).toEqual({from:first.from,to:first.to,quote:'“我知道。”'});
  expect(EvidenceSchema.safeParse(evidence).success).toBe(true);
});
it('TEST consecutive indexed evidence includes original paragraph separators rather than model copies', () => {
  const source='TEST 门又被推开了。\n\n一个男人进来。';
  const spans=indexProseEvidence(source),last=spans.at(-1)!;
  expect(locateIndexedEvidence(source,spans,{startSpan:spans[0]!.id,endSpan:last.id}).quote).toBe(source);
  expect(indexedEvidenceSchema(spans).safeParse({startSpan:'invented',endSpan:last.id}).success).toBe(false);
  expect(()=>locateIndexedEvidence(source,spans,{startSpan:last.id,endSpan:spans[0]!.id})).toThrow('必须在');
});
it('TEST stale indexes, whitespace-only and oversized ranges cannot become evidence', () => {
  const source='TEST 第一行。\n\n第二行。',spans=indexProseEvidence(source);
  expect(()=>locateIndexedEvidence(source.replace('第一','修改'),spans,{startSpan:'s1',endSpan:'s1'})).toThrow('不一致');
  const blank=spans.find(s=>!s.text.trim())!;
  expect(()=>locateIndexedEvidence(source,spans,{startSpan:blank.id,endSpan:blank.id})).toThrow('实质原文');
  const big='TEST '+ '长'.repeat(5000),bigSpans=indexProseEvidence(big);
  expect(()=>locateIndexedEvidence(big,bigSpans,{startSpan:bigSpans[0]!.id,endSpan:bigSpans.at(-1)!.id})).toThrow('4000');
});
it('TEST long spans are split without cutting UTF-16 surrogate pairs, and no source is dropped', () => {
  const source='TEST '+ '😀'.repeat(1100),spans=indexProseEvidence(source);
  expect(spans.map(s=>s.text).join('')).toBe(source);
  for(const s of spans) {
    expect(s.text.length).toBeLessThanOrEqual(1000);
    expect(/[\uD800-\uDBFF]$/u.test(s.text)).toBe(false);
    expect(/^[\uDC00-\uDFFF]/u.test(s.text)).toBe(false);
  }
  expect(()=>indexedEvidenceSchema([])).toThrow('正文为空');
});
