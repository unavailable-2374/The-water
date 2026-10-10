/** TEST prompt routing and storage compatibility; no model output or literary quality claim. */
import { describe, expect, it } from 'vitest';
import { CharacterIntentSchema } from '@the-water/shared';
import { CHARACTER_DESIGN_RULE, CHARACTER_PLANNING_RULE, CHARACTER_REVIEW_RULE } from '@/novel/characterDesign';
import { writeChapterPrompt } from '@/llm/prompts/writeChapter';
import { rewriteChapterPrompt } from '@/llm/prompts/rewriteChapter';
import { lengthAdjustPrompt } from '@/llm/prompts/lengthAdjust';
import { outlinePrompt } from '@/llm/prompts/outline';
import { narrativeReviewPrompt } from '@/llm/prompts/narrativeReview';
import { storyRevisionIssues } from '@/novel/storyQuality';
import { caps, requirements } from '../fixtures/storyline';

describe('TEST character guidance reaches production prompt builders', () => {
  const input = { chapterNo: 1, requirements, contextUserText: 'TEST confirmed context', targetChars: 1500, caps };
  it('shares one copy through writing, both rewrite modes, expansion and trimming', () => {
    const prompts = [
      writeChapterPrompt(input),
      ...(['revise', 'rewrite'] as const).map(mode => rewriteChapterPrompt({ ...input, mode, oldText: 'TEST prose', instructions: ['TEST instruction'] })),
      ...(['expand', 'trim'] as const).map(mode => lengthAdjustPrompt({ ...input, mode, chapterText: 'TEST prose', chapterPlanText: 'TEST plan', actual: 1000, target: 1500 })),
    ];
    for (const prompt of prompts) {
      const system = prompt.messages[0]!.content;
      expect(system.split(CHARACTER_DESIGN_RULE)).toHaveLength(2);
      expect(system).not.toContain('【人物设计落入现有字段】');
      expect(system).not.toContain('【人物审查边界】');
    }
  });
  it('separates planning field instructions from evidence-based prose review', () => {
    const plan = outlinePrompt({ premise: 'TEST premise', requirements, chapterCount: 5, targetChars: 8000 });
    const review = narrativeReviewPrompt({ chapterNo: 1, text: 'TEST prose', context: 'TEST confirmed plan' });
    expect(plan.messages.map(m => m.content).join('\n').split(CHARACTER_PLANNING_RULE)).toHaveLength(2);
    expect(review.messages[0]!.content.split(CHARACTER_REVIEW_RULE)).toHaveLength(2);
    expect(review.messages[0]!.content).not.toContain('【人物设计落入现有字段】');
  });
  it('does not impose fiction character guidance on nonfiction writing or outlines', () => {
    const nonfiction = { ...requirements, docType: 'tech-blog' as const };
    const prompts = [writeChapterPrompt({ ...input, requirements: nonfiction }), outlinePrompt({ premise: 'TEST technical subject', requirements: nonfiction, chapterCount: 1, targetChars: 1500 })];
    for (const prompt of prompts) expect(prompt.messages.map(m => m.content).join('\n')).not.toContain(CHARACTER_DESIGN_RULE);
  });
  it('keeps legacy intent cards readable and literary preferences outside automatic repair', () => {
    expect(CharacterIntentSchema.safeParse({ characterId: 'TEST-character', goal: 'TEST goal', motivation: 'TEST motive', contradiction: 'TEST tension', growth: [] }).success).toBe(true);
    expect(storyRevisionIssues([{ id: 'TEST-preference', category: 'style', severity: 'suggestion', evidence: { from: 0, to: 4, quote: 'TEST' }, basis: 'TEST prefer more internal layers', suggestion: 'TEST optional expansion', sourceIds: [] }], { verdict: 'ready' })).toEqual([]);
  });
});
