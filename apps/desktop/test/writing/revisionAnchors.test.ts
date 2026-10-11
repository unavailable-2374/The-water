// TEST fictional prose. These deterministic contract tests do not simulate real generation results.
import { describe, expect, it } from 'vitest';
import type { ReviewIssue } from '@the-water/shared';
import { AnchoredRevisionPatchesSchema, applyRevisionPatches, resolveRevisionPatches } from '@/novel/textProposals';

const prose = 'TEST 😀门外。\n\n“押金你留着。”她说。\n\n弟弟愣住。他没想到她已经知道计划。她抱起纸箱。\n\n店门关上。';
const quote = '他没想到她已经知道计划。';
const issue = { id: 'TEST-knowledge', category: 'knowledge', severity: 'block', evidence: { from: prose.indexOf(quote), to: prose.indexOf(quote) + quote.length, quote }, basis: 'TEST 无来源知识', suggestion: 'TEST 补足来源', sourceIds: [] } as unknown as ReviewIssue;

describe('TEST exact revision anchors', () => {
  it('resolves UTF-16 positions and cross-paragraph prose without asking the model to copy the original range', () => {
    const replacement = '“押金你留着。”她说。\n\n她指了指弟弟刚给她的租约。弟弟愣住。她抱起纸箱。';
    const patches = resolveRevisionPatches(prose, [{ startQuote: '“押金你留着。”她说。', endQuote: '她抱起纸箱。', replacement }]);
    expect(patches[0]!.original).toBe('“押金你留着。”她说。\n\n弟弟愣住。他没想到她已经知道计划。她抱起纸箱。');
    expect(applyRevisionPatches(prose, patches, [issue]).text).toBe('TEST 😀门外。\n\n' + replacement + '\n\n店门关上。');
  });
  it('supports a single unique quotation as both anchors', () => {
    const patches = resolveRevisionPatches(prose, [{ startQuote: quote, endQuote: quote, replacement: '他看见她读完租约。' }]);
    expect(applyRevisionPatches(prose, patches, [issue]).text).toBe(prose.replace(quote, '他看见她读完租约。'));
  });
  it('rejects missing newlines with actionable field diagnostics rather than normalizing source prose', () => {
    expect(() => resolveRevisionPatches(prose, [{ startQuote: '“押金你留着。”她说。弟弟愣住。', endQuote: quote, replacement: 'TEST' }])).toThrow('patches.0.startQuote');
  });
  it('rejects ambiguous, absent and reversed anchors', () => {
    expect(() => resolveRevisionPatches('TEST 门。门。', [{ startQuote: '门。', endQuote: '门。', replacement: '' }])).toThrow('唯一');
    expect(() => resolveRevisionPatches(prose, [{ startQuote: quote, endQuote: '不存在', replacement: '' }])).toThrow('patches.0.endQuote');
    expect(() => resolveRevisionPatches(prose, [{ startQuote: '店门关上。', endQuote: quote, replacement: '' }])).toThrow('必须位于');
  });
  it('retains whole-chapter, overlap and evidence-coverage gates', () => {
    const whole = resolveRevisionPatches(prose, [{ startQuote: 'TEST 😀门外。', endQuote: '店门关上。', replacement: 'TEST' }]);
    expect(() => applyRevisionPatches(prose, whole, [issue])).toThrow('整章');
    const remote = resolveRevisionPatches(prose, [{ startQuote: '店门关上。', endQuote: '店门关上。', replacement: '门开了。' }]);
    expect(() => applyRevisionPatches(prose, remote, [issue])).toThrow('没有覆盖');
    const overlapping = resolveRevisionPatches(prose, [
      { startQuote: '弟弟愣住。', endQuote: '她抱起纸箱。', replacement: 'TEST' },
      { startQuote: quote, endQuote: quote, replacement: 'TEST' },
    ]);
    expect(() => applyRevisionPatches(prose, overlapping, [issue])).toThrow('重叠');
  });
  it('requires nonempty anchors and preserves an empty patch set for author review', () => {
    expect(AnchoredRevisionPatchesSchema.safeParse({ patches: [{ startQuote: '', endQuote: quote, replacement: '' }] }).success).toBe(false);
    expect(resolveRevisionPatches(prose, [])).toEqual([]);
  });
});
