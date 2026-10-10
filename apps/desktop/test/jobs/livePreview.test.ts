import { describe, expect, it } from 'vitest';
import { PROSE_STEP_KINDS, isProseStep, type StepKind } from '@/db/repos/jobsRepo';

const ALL: StepKind[] = [
  'scene_plan', 'write_scenes', 'commit_chapter', 'outline', 'chapter_table', 'write_chapter', 'adjust_length',
  'summarize', 'rewrite_chapter', 'name_replace', 'style_check', 'extract_style',
];

describe('章节编辑器的流式预览只认正文步骤', () => {
  it('只有写章 / 改写 / 调长 / 风格审校算正文', () => {
    expect([...PROSE_STEP_KINDS]).toEqual(['write_scenes', 'write_chapter', 'rewrite_chapter', 'adjust_length', 'style_check']);
  });

  it('输出 JSON 的步骤一律不算', () => {
    // 曾经的 bug：summarize 带着 chapterId 又往正文通道推流，
    // 于是读者在第一章正文区看到 {"summary":"…","bibleDelta":{…}}。
    for (const k of ['summarize', 'outline', 'chapter_table', 'extract_style', 'name_replace'] as StepKind[]) {
      expect(isProseStep(k)).toBe(false);
    }
  });

  it('覆盖全部步骤种类，新增种类必须显式归类', () => {
    for (const k of ALL) expect(typeof isProseStep(k)).toBe('boolean');
    expect(ALL.filter(isProseStep).sort()).toEqual([...PROSE_STEP_KINDS].sort());
  });
});
