/** TEST strings validate source anchoring, not literary quality. */
import { expect, it } from 'vitest';
import { ModelEvidenceSchema, locateModelEvidence } from '@/llm/prompts/evidence';
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
