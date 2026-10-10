/** TEST / SIMULATED model output; no literary quality claim. */
import { expect, it } from 'vitest';
import { BranchSampleSchema } from '@/novel/storyBranches';
import { zodToJsonSchema } from '@/llm/json';
import { locateModelEvidence } from '@/llm/prompts/evidence';

const sample = 'TEST 林舟留下信件。他核对邮戳。';
const result = (quote: string, from = 0, to = quote.length) => ({
  sample,
  facts: [{ text: 'TEST 核对邮戳', evidence: { from, to, quote } }],
});
it('rejects invented evidence before a branch response can be saved', () => {
  const parsed = BranchSampleSchema.safeParse(result('TEST 他打开信件。'));
  expect(parsed.success).toBe(false);
  if (!parsed.success) expect(parsed.error.issues[0]!.path).toEqual(['facts', 0, 'evidence']);
});
it('accepts uniquely located verbatim evidence despite model offset errors', () => {
  const value = BranchSampleSchema.parse(result('他核对邮戳。'));
  const evidence = locateModelEvidence(value.sample, value.facts[0]!.evidence);
  expect(value.sample.slice(evidence.from, evidence.to)).toBe('他核对邮戳。');
});
it('rejects ambiguous quotes and keeps the provider JSON schema serializable', () => {
  expect(BranchSampleSchema.safeParse({ ...result('他核对邮戳。'), sample: sample + '他核对邮戳。' }).success).toBe(false);
  expect(zodToJsonSchema(BranchSampleSchema)).toMatchObject({ type: 'object', required: ['sample', 'facts'] });
});
