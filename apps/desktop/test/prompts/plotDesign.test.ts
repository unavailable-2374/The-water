/** TEST prompt integration only; no generated story or literary-quality measurement. */
import { expect, it } from 'vitest';
import { PLOT_DESIGN_RULE, PLOT_GENRE_RULE, PLOT_PLANNING_RULE, PLOT_REVIEW_RULE } from '@/novel/plotDesign';
import { writeChapterPrompt } from '@/llm/prompts/writeChapter';
import { rewriteChapterPrompt } from '@/llm/prompts/rewriteChapter';
import { lengthAdjustPrompt } from '@/llm/prompts/lengthAdjust';
import { outlinePrompt } from '@/llm/prompts/outline';
import { chapterTablePrompt } from '@/llm/prompts/chapterTable';
import { narrativeReviewPrompt } from '@/llm/prompts/narrativeReview';
import { caps, requirements } from '../fixtures/storyline';
import { OutlineDocSchema } from '@/novel/types';

const input = { chapterNo: 1, requirements, contextUserText: 'TEST confirmed context', targetChars: 1500, caps };
const chapterInput = { outline: OutlineDocSchema.parse({ title: 'TEST outline', logline: 'TEST mainline', arcs: [{ title: 'TEST arc', summary: 'TEST cause and consequence', startChapterNo: 1, endChapterNo: 4 }], beats: [{ arcIndex: 0, title: 'TEST choice', summary: 'TEST consequence', suggestedChapterNo: 1 }] }), requirements, fromChapter: 1, toChapter: 1, totalChapters: 4, batchTotalChars: 1500, minChars: 1000, maxChars: 2000, previousEntries: [] };
it('TEST prose and revision receive shared plot guidance without planning field instructions', () => {
  const prompts = [writeChapterPrompt(input), rewriteChapterPrompt({ ...input, mode: 'revise', oldText: 'TEST prose', instructions: [] }), lengthAdjustPrompt({ ...input, mode: 'trim', chapterText: 'TEST prose', actual: 2000, target: 1500, chapterPlanText: 'TEST plan' })];
  for (const prompt of prompts) {
    expect(prompt.messages[0]!.content.split(PLOT_DESIGN_RULE)).toHaveLength(2);
    expect(prompt.messages[0]!.content).toContain(PLOT_GENRE_RULE);
    expect(prompt.messages[0]!.content).not.toContain('【情节规划落入现有字段】');
  }
});
it('TEST both outline and chapter table receive planning guidance; independent review receives review boundaries', () => {
  const prompts = [outlinePrompt({ premise: 'TEST premise', requirements, chapterCount: 4, targetChars: 6000 }), chapterTablePrompt(chapterInput)];
  for (const prompt of prompts) expect(prompt.messages.map(m => m.content).join('\n').split(PLOT_PLANNING_RULE)).toHaveLength(2);
  const review = narrativeReviewPrompt({ chapterNo: 1, text: 'TEST prose', context: 'TEST confirmed plan' });
  expect(review.messages[0]!.content.split(PLOT_REVIEW_RULE)).toHaveLength(2);
  expect(review.messages[0]!.content).not.toContain('【情节规划落入现有字段】');
});
it('TEST nonfiction builders keep their existing contracts without fiction plot guidance', () => {
  const nonfiction = { ...requirements, docType: 'tech-blog' as const };
  const prompts = [writeChapterPrompt({ ...input, requirements: nonfiction }), outlinePrompt({ premise: 'TEST technical subject', requirements: nonfiction, chapterCount: 1, targetChars: 1500 }), chapterTablePrompt({ ...chapterInput, requirements: nonfiction })];
  for (const prompt of prompts) expect(prompt.messages.map(m => m.content).join('\n')).not.toContain(PLOT_DESIGN_RULE);
});
