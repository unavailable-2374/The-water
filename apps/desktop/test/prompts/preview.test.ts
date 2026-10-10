/** TEST: preview examples are illustrative inputs, never generated writing results. */
import { expect, it } from 'vitest';
import { promptPreviews } from '@/llm/prompts/preview';

it('TEST settings preview renders every advertised template under current schemas', () => {
  const previews = promptPreviews();
  expect(previews.map(p => p.id)).toEqual([
    'write_chapter', 'rewrite_chapter', 'adjust_length', 'outline', 'chapter_table',
    'summarize', 'style_review', 'consistency_review', 'extract_style',
    'rewrite_plan', 'passage_discuss',
  ]);
  for (const preview of previews) {
    expect(preview.system.trim(), preview.id).not.toBe('');
    expect(preview.user.trim(), preview.id).not.toBe('');
    expect(Number.isFinite(preview.temperature), preview.id).toBe(true);
  }
});

it('TEST prose previews preserve the author instruction without a model call', () => {
  const note = 'TEST 作者要求：保留秘密，不提前揭示。';
  const previews = promptPreviews(note);
  for (const id of ['write_chapter', 'rewrite_chapter', 'adjust_length']) {
    const preview = previews.find(p => p.id === id)!;
    expect(preview.system + preview.user, id).toContain(note);
  }
});
