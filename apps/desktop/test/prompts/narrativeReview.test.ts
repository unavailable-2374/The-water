import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { locateNarrativeIssues, NarrativeReviewSchema, narrativeSourceError, narrativeReviewPrompt, locateNarrativeStory } from '@/llm/prompts/narrativeReview';
import { ChapterLengthReviewSchema, ReviewIssueSchema, StoryAssessmentSchema } from '@the-water/shared';
import { indexProseEvidence } from '@/llm/prompts/evidence';
import { testReadyStory, testReadyLengthReview } from '../helpers/writing';

const issue = (quote: string) => ({
  id: 'TEST-issue', category: 'knowledge', severity: 'block', evidence: { quote },
  basis: 'TEST confirmed knowledge constraint', suggestion: 'TEST revise the premature disclosure', sourceIds: ['TEST-source'],
});

describe('TEST model quotes become verified review evidence', () => {
  it('computes Chinese and surrogate-pair UTF-16 offsets itself, ignoring untrusted model positions', () => {
    const text = 'TEST 🌊前文。她提前知道了暗号。后文。';
    const model = NarrativeReviewSchema.pick({issues:true}).parse({ issues: [{ ...issue('她提前知道了暗号。'), evidence: { quote: '她提前知道了暗号。', from: 999, to: 1000 } }] });
    expect(model.issues[0]!.evidence).toEqual({ quote: '她提前知道了暗号。' });
    const located = locateNarrativeIssues(text, model.issues);
    expect(located[0]!.evidence.from).toBe(text.indexOf('她提前知道了暗号。'));
    expect(text.slice(located[0]!.evidence.from, located[0]!.evidence.to)).toBe('她提前知道了暗号。');
    expect(ReviewIssueSchema.safeParse(located[0]).success).toBe(true);
  });
  it('rejects missing or ambiguous quotations rather than assigning made-up positions', () => {
    expect(() => locateNarrativeIssues('TEST 原文', NarrativeReviewSchema.pick({issues:true}).parse({ issues: [issue('不存在')] }).issues)).toThrow('missing or ambiguous');
    expect(() => locateNarrativeIssues('TEST 重复，重复', NarrativeReviewSchema.pick({issues:true}).parse({ issues: [issue('重复')] }).issues)).toThrow('missing or ambiguous');
  });
  it('rejects oversized new explanations without truncating or invalidating legacy storage', () => {
    const long = 'TEST '.repeat(170);
    expect(NarrativeReviewSchema.pick({issues:true}).safeParse({ issues: [{ ...issue('TEST'), basis: long }] }).success).toBe(false);
    expect(ReviewIssueSchema.safeParse({ ...issue('TEST'), evidence: { from: 0, to: 4, quote: 'TEST' }, basis: long }).success).toBe(true);
  });
});


it('TEST genre guidance may support suggestions but cannot be the sole source for a hard conflict', () => {
  const available = new Set(['TEST-genre', 'TEST-canon']);
  const advisory = new Set(['TEST-genre']);
  expect(narrativeSourceError({ severity: 'block', sourceIds: ['TEST-genre'] }, available, advisory)).toContain('不能单独');
  expect(narrativeSourceError({ severity: 'suggestion', sourceIds: ['TEST-genre'] }, available, advisory)).toBeNull();
  expect(narrativeSourceError({ severity: 'block', sourceIds: ['TEST-canon'] }, available, advisory)).toBeNull();
  expect(narrativeSourceError({ severity: 'block', sourceIds: ['TEST-unknown'] }, available, advisory)).toContain('不得编造');
  const reminders = ['TEST mystery reminder', 'TEST urban reminder', 'TEST fantasy reminder'];
  const prompt = narrativeReviewPrompt({ chapterNo: 1, text: 'TEST prose', context: 'TEST context', qcReminders: reminders });
  for (const reminder of reminders) expect(prompt.messages.at(-1)!.content).toContain(reminder);
});

it('TEST length verdicts require matching evidence-linked actions, and prose scanning avoids quotas',()=>{
  expect(ChapterLengthReviewSchema.safeParse({action:'expand',reason:'TEST missing choice',actions:[]}).success).toBe(false);
  expect(ChapterLengthReviewSchema.safeParse({action:'mixed',reason:'TEST missing choice and repetition',actions:[{action:'expand',issueId:'TEST-a'},{action:'trim',issueId:'TEST-b'}]}).success).toBe(true);
  expect(ChapterLengthReviewSchema.safeParse({action:'keep',reason:'TEST complete scene',actions:[]}).success).toBe(true);
  const system=String(narrativeReviewPrompt({chapterNo:1,text:'TEST prose',context:'TEST plan'}).messages[0]!.content);
  expect(system).toContain('扫描整章');expect(system).toContain('不能仅因短于或超过参考字数判断');expect(system).toContain('独立于写作人');
});

it('TEST model-facing review schema requires every mandatory channel before execution',()=>{
  const schema=z.toJSONSchema(NarrativeReviewSchema,{io:'input'});
  expect(schema.required).toEqual(expect.arrayContaining(['issues','story','lengthReview']));
  expect(NarrativeReviewSchema.safeParse({issues:[]}).success).toBe(false);
});


describe('TEST indexed narrative evidence (SIMULATED reviewer fixtures)', () => {
  const text = 'TEST 🌊。\n\n“关了。”他说。\n\n许宁看着他的手指从屏幕上移开。“我没让你删。”\n\n“我知道。”\n\n“我也没夸你。”\n\n“嗯。”\n\n“我知道。”';
  function fixture() {
    const spans = indexProseEvidence(text);
    const start = spans.find(s => s.text === '“关了。”')!;
    const end = spans.find(s => s.text === '“嗯。”')!;
    const evidence = { startSpan: start.id, endSpan: end.id };
    return { issues: [{ ...issue('unused TEST legacy quote'), evidence }],
      lengthReview: testReadyLengthReview(),
      story: { ...testReadyStory(), changes: [{ kind: 'relationship', before: 'TEST pressured', after: 'TEST agency preserved', evidence }],
        expectations: [{ id: 'TEST-promise', question: 'TEST stop?', response: 'TEST closes page', status: 'paid', evidence }] },
    };
  }
  it('preserves exact multi-paragraph evidence without asking the model to recopy whitespace', () => {
    const prompt = narrativeReviewPrompt({ chapterNo: 3, text, context: 'TEST context' });
    const value = prompt.schema!.parse(fixture());
    const issues = locateNarrativeIssues(text, value.issues);
    const story = locateNarrativeStory(text, value.story);
    expect(issues[0]!.evidence.quote).toBe('“关了。”他说。\n\n许宁看着他的手指从屏幕上移开。“我没让你删。”\n\n“我知道。”\n\n“我也没夸你。”\n\n“嗯。”');
    expect(issues[0]!.evidence.from).toBe(text.indexOf('“关了。”'));
    expect(story.changes[0]!.evidence).toEqual(issues[0]!.evidence);
    expect(story.expectations[0]!.evidence).toEqual(issues[0]!.evidence);
    expect(StoryAssessmentSchema.safeParse(story).success).toBe(true);
  });
  it('checks all evidence fields and rejects reversed, blank and unknown ranges', () => {
    const prompt = narrativeReviewPrompt({ chapterNo: 3, text, context: 'TEST context' });
    const value = fixture();
    value.story.changes[0]!.evidence = { startSpan: 's4', endSpan: 's1' };
    value.story.expectations[0]!.evidence = { startSpan: 's2', endSpan: 's2' };
    const result = prompt.schema!.safeParse(value);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map(i => i.path.join('.'))).toEqual(expect.arrayContaining(['story.changes.0.evidence', 'story.expectations.0.evidence']));
    expect(prompt.schema!.safeParse({ ...fixture(), issues: [{ ...issue('TEST'), evidence: { startSpan: 'missing', endSpan: 'missing' } }] }).success).toBe(false);
    expect(prompt.schema!.safeParse({ ...fixture(), issues: [issue('“关了。”他说。 “我知道。”')] }).success).toBe(false);
  });
  it('distinguishes repeated dialogue using authoritative source IDs', () => {
    const prompt = narrativeReviewPrompt({ chapterNo: 3, text, context: 'TEST context' });
    const repeated = indexProseEvidence(text).filter(s => s.text === '“我知道。”');
    expect(repeated).toHaveLength(2);
    const value = fixture();
    value.issues[0]!.evidence = { startSpan: repeated[1]!.id, endSpan: repeated[1]!.id };
    const parsed = prompt.schema!.parse(value);
    expect(locateNarrativeIssues(text, parsed.issues)[0]!.evidence.from).toBe(text.lastIndexOf('“我知道。”'));
  });
  it('advertises indexed evidence consistently for issues, changes and expectations', () => {
    const prompt = narrativeReviewPrompt({ chapterNo: 3, text, context: 'TEST context' });
    const wire = JSON.stringify(z.toJSONSchema(prompt.schema!));
    expect(wire).toContain('startSpan');
    expect(wire).not.toContain('"quote"');
    const spans = indexProseEvidence(text);
    expect(prompt.messages.at(-1)!.content).toContain(JSON.stringify(spans.map(({ id, text }) => ({ id, text }))));
    expect(String(prompt.messages[0]!.content)).not.toContain('evidence.quote');
  });
});
