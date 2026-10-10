/** TEST / SIMULATED review fixtures. Tests validation contracts, not model literary quality. */
import { expect, it } from 'vitest';
import { testQualityAudit } from '../helpers/storyOptionAudit';
import { optionComparisonModelSchema, optionReviewRequest, optionDifferenceRequest, finalizeOptionComparison, optionQualityBlocked } from '@/novel/storyOptionQuality';
import { zodToJsonSchema } from '@/llm/json';
import { StoryOptionSchema, type StoryOption } from '@the-water/shared';

const options: StoryOption[] = Array.from({ length: 4 }, (_, i) => ({ id: `TEST ${i}`, design: { causalSpine: `TEST spine ${i}`, decisiveChoice: `TEST choice ${i}`, resolutionMechanism: `TEST resolution ${i}` }, title: 'TEST SIMULATED', mainline: 'TEST accepts partnership before winning', conflict: 'TEST conflict', choiceAndCost: 'TEST extortion costs friendship', growth: 'TEST changes behavior', turns: ['TEST wins then accepts partnership'], ending: 'TEST outcome', aftermath: 'TEST potential aftermath' }));
const linkCoreFindings = (r: ReturnType<typeof review>) => { for (const o of r.options) { const indices = o.findings.flatMap((f, i) => f.kind === 'editorial' ? [] : [i]); if (indices.length) Object.assign(o.qualityAudit[0]!, { status: 'gap', evidence: [], findingIndices: indices }); } return r; };
const snapshot = { authorInput: { premise: 'TEST explicit author framework', requirements: { extra: 'TEST must preserve agency' } }, authorMaterials: 'TEST explicit relationship mechanism' };
const review = () => ({ differences: options.flatMap((left, i) => options.slice(i + 1).map(right => ({ leftId: left.id, rightId: right.id, judgment: 'substantive' as const, axes: (['causalSpine', 'decisiveChoice'] as const).map(axis => ({ axis, leftQuote: left.design![axis], rightQuote: right.design![axis], explanation: 'TEST SIMULATED substantive difference' })) }))), options: options.map(o => ({ optionId: o.id, qualityAudit: testQualityAudit(o), conflict: 'TEST conflict', character: 'TEST character', turns: 'TEST turns', emotion: 'TEST emotion', ending: 'TEST ending', tradeoff: 'TEST tradeoff', checks: { fieldConsistency: 'TEST compare mainline and turns', causality: 'TEST inspect mechanism', characterRequirements: 'TEST inspect requirements', payoffs: 'TEST inspect choices', distinctness: 'TEST compare causal spines' }, findings: [] as { kind: 'hard_constraint' | 'contradiction' | 'missing_information' | 'editorial'; field: 'mainline' | 'choiceAndCost'; quote: string; authorQuote: string; explanation: string; revision: string }[] })) });

it('TEST pair request restores actual design evidence and rejects external, duplicate or single-axis pairs', () => {
  const request = optionDifferenceRequest(options);
  const wire = () => ({ differences: review().differences.map(p => ({ ...p, axes: p.axes.map(({ axis, explanation }) => ({ axis, explanation })) })) });
  expect(request.decode(request.schema.parse(wire())).differences).toEqual(review().differences);
  const external = wire(); external.differences[0]!.leftId = 'TEST external card';
  expect(() => request.schema.parse(external)).toThrow('外部卡片');
  const repeated = wire(); repeated.differences[1] = repeated.differences[0]!;
  expect(() => request.schema.parse(repeated)).toThrow('不能重复');
  const oneAxis = wire(); oneAxis.differences[0]!.axes = oneAxis.differences[0]!.axes.slice(0, 1);
  expect(() => request.schema.parse(oneAxis)).toThrow('至少有两个');
  expect(zodToJsonSchema(request.schema)).toBeTruthy();
});

it('TEST internal contradictions and missing events remain explicit concerns, not invented author violations', () => {
  const r = review();
  r.options[0]!.findings = [{ kind: 'contradiction', field: 'mainline', quote: options[0]!.mainline, authorQuote: '', explanation: 'TEST turns place partnership after winning', revision: 'TEST align chronology' }, { kind: 'missing_information', field: 'choiceAndCost', quote: options[0]!.choiceAndCost, authorQuote: '', explanation: 'TEST extortion event not provided', revision: 'TEST show choice and consequence' }];
  const result = finalizeOptionComparison(optionComparisonModelSchema(options, snapshot, '').parse(linkCoreFindings(r)));
  expect(result.options[0]!.violations).toEqual([]);
  expect(result.options[0]!.concerns).toHaveLength(2);
  expect(result.options[0]!.concerns[0]).toContain('明确矛盾');
  expect(result.summary).toContain('1 个有矛盾');
});
it('TEST fabricated quotations and old-story constraints are rejected before persistence', () => {
  const schema = optionComparisonModelSchema(options, snapshot, ''), r = review();
  r.options[0]!.findings = [{ kind: 'hard_constraint', field: 'mainline', quote: options[0]!.mainline, authorQuote: 'TEST old adopted storyline', explanation: 'TEST explanation', revision: 'TEST revision' }];
  expect(() => schema.parse(r)).toThrow('不得引用旧故事线');
  r.options[0]!.findings[0]!.authorQuote = 'TEST must preserve agency';
  r.options[0]!.findings[0]!.quote = 'TEST fabricated evidence';
  expect(() => schema.parse(r)).toThrow();
});
it('TEST genuine explicit-input violations determine the aggregate summary and selection violations', () => {
  const r = review();
  r.options[0]!.findings = [{ kind: 'hard_constraint', field: 'choiceAndCost', quote: options[0]!.choiceAndCost, authorQuote: 'TEST must preserve agency', explanation: 'TEST SIMULATED hard violation', revision: 'TEST revision' }];
  const result = finalizeOptionComparison(optionComparisonModelSchema(options, snapshot, '').parse(linkCoreFindings(r)));
  expect(result.options[0]!.violations[0]).toContain('TEST must preserve agency');
  expect(result.summary).toContain('1 个被指出违反');
});
it('TEST incomplete check coverage and mismatched option identities cannot pass the comparison schema', () => {
  const r = review(), schema = optionComparisonModelSchema(options, snapshot, '');
  expect(() => schema.parse({ options: r.options.map(o => ({ ...o, checks: { causality: 'TEST only one check' } })) })).toThrow();
  r.options[1]!.optionId = r.options[0]!.optionId;
  expect(() => schema.parse(r)).toThrow('真实 optionId');
});

it('TEST pairwise difference claims require complete pair coverage and quotes from two distinct design axes', () => {
  const r = review(), schema = optionComparisonModelSchema(options, snapshot, '');
  r.differences[0]!.axes = r.differences[0]!.axes.slice(0, 1);
  expect(() => schema.parse(r)).toThrow('至少有两个');
  const repeated = review();
  repeated.differences[1] = repeated.differences[0]!;
  expect(() => schema.parse(repeated)).toThrow('不能重复');
  const fabricated = review();
  fabricated.differences[0]!.axes[0]!.leftQuote = 'TEST fabricated difference';
  expect(() => schema.parse(fabricated)).toThrow('逐字引用');
});

it('TEST passing a summary promise without an event citation cannot establish readiness', () => {
  const r = review(), schema = optionComparisonModelSchema(options, snapshot, '');
  r.options[0]!.qualityAudit[1]!.evidence = [];
  expect(() => schema.parse(r)).toThrow('事件证据');
  r.options[0]!.qualityAudit[1]!.evidence = [{ field: 'turns', quote: options[0]!.ending }];
  expect(() => schema.parse(r)).toThrow();
});

it('TEST core gaps block readiness while ordinary editorial suggestions remain selectable', () => {
  const r = review(), schema = optionComparisonModelSchema(options, snapshot, '');
  r.options[0]!.findings = [{ kind: 'missing_information', field: 'choiceAndCost', quote: options[0]!.choiceAndCost, authorQuote: '', explanation: 'TEST missing relationship process', revision: 'TEST establish relationship before loss' }];
  const audit = r.options[0]!.qualityAudit[2]!;
  Object.assign(audit, { status: 'gap', evidence: [], findingIndices: [0] });
  const result = finalizeOptionComparison(schema.parse(r));
  expect(optionQualityBlocked(result)).toBe(true);
  expect(result.summary).toContain('无关键缺口的卡可独立选择');
  audit.findingIndices = [3];
  expect(() => schema.parse(r)).toThrow('关联本卡真实');
  Object.assign(audit, { status: 'supported', evidence: [{ field: 'turns', quote: options[0]!.turns[0]! }], findingIndices: [] });
  r.options[0]!.findings[0]!.kind = 'editorial';
  expect(optionQualityBlocked(finalizeOptionComparison(schema.parse(r)))).toBe(false);
});

it('TEST contradictions cannot become ready merely because pairwise differentiation passed', () => {
  const r = review();
  r.options[0]!.findings = [{ kind: 'contradiction', field: 'mainline', quote: options[0]!.mainline, authorQuote: '', explanation: 'TEST incompatible order', revision: 'TEST align chronology' }];
  expect(optionQualityBlocked(finalizeOptionComparison(optionComparisonModelSchema(options, snapshot, '').parse(linkCoreFindings(r))))).toBe(true);
});

it('TEST omitted or duplicated audit checkpoints and falsely supported gaps are rejected', () => {
  const schema = optionComparisonModelSchema(options, snapshot, ''), r = review();
  r.options[0]!.qualityAudit[1]!.checkpoint = 'scopeCoverage';
  expect(() => schema.parse(r)).toThrow('五个不同');
  const unsupported = review();
  Object.assign(unsupported.options[0]!.qualityAudit[0]!, { status: 'gap', evidence: [], findingIndices: [] });
  expect(() => schema.parse(unsupported)).toThrow('关键缺口必须关联');
});

it('TEST admitting a core missing event while passing all audits cannot reach readiness', () => {
  const r = review();
  r.options[0]!.findings = [{ kind: 'missing_information', field: 'choiceAndCost', quote: options[0]!.choiceAndCost, authorQuote: '', explanation: 'TEST missing core process', revision: 'TEST supply events' }];
  expect(() => optionComparisonModelSchema(options, snapshot, '').parse(r)).toThrow('不能承认关键缺失又全项通过');
});

it('TEST design findings use their actual field, and author requirements cannot be quoted as candidate events', () => {
  const r = review(), schema = optionComparisonModelSchema(options, snapshot, '');
  const finding = { kind: 'missing_information' as const, field: 'resolutionMechanism' as const, quote: options[0]!.design!.resolutionMechanism, authorQuote: '', explanation: 'TEST resolution lacks a trigger', revision: 'TEST establish trigger' };
  const item = { ...r.options[0], findings: [finding], qualityAudit: r.options[0]!.qualityAudit.map((a, i) => i === 3 ? { ...a, status: 'gap', findingIndices: [0] } : a) };
  expect(schema.safeParse({ ...r, options: [item, ...r.options.slice(1)] }).success).toBe(true);
  expect(() => schema.parse({ ...r, options: [{ ...item, findings: [{ ...finding, field: 'outline' }] }, ...r.options.slice(1)] })).toThrow();
  expect(() => schema.parse({ ...r, options: [{ ...item, findings: [{ ...finding, field: 'mainline', quote: snapshot.authorInput.premise }] }, ...r.options.slice(1)] })).toThrow();
});

it('TEST citation identifiers round-trip actual source text and reject fabricated or cross-card evidence', () => {
  const request = optionReviewRequest(options, snapshot, '');
  const r = review();
  const wire = { ...r, options: r.options.map(o => ({ ...o, findings: [], qualityAudit: o.qualityAudit.map(a => ({ checkpoint: a.checkpoint, notApplicable: false, explanation: a.explanation, evidenceIds: [request.citations.find(c => c.optionId === o.optionId && c.field === 'turns')!.id] })) })) };
  expect(() => zodToJsonSchema(request.schema)).not.toThrow();
  const decoded = request.decode(request.schema.parse(wire));
  expect(decoded.options[0]!.qualityAudit[0]!.evidence).toEqual([{ field: 'turns', quote: options[0]!.turns[0] }]);
  wire.options[0]!.qualityAudit[0]!.evidenceIds = ['TEST FABRICATED ID'];
  expect(request.schema.safeParse(wire).success).toBe(false);
  wire.options[0]!.qualityAudit[0]!.evidenceIds = [request.citations.find(c => c.optionId === options[1]!.id && c.field === 'turns')!.id];
  expect(() => request.schema.parse(wire)).toThrow('不能引用另一张卡');
});

it('TEST full-book card permits more than eight causal paragraphs without dropping phase outcomes', () => {
  const paragraphs = Array.from({ length: 12 }, (_, i) => `TEST SIMULATED causal paragraph ${i}`);
  expect(StoryOptionSchema.parse({ ...options[0], outline: paragraphs }).outline).toEqual(paragraphs);
  expect(() => StoryOptionSchema.parse({ ...options[0], outline: Array(17).fill(paragraphs[0]) })).toThrow();
});
