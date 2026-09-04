import type { ProviderCaps, PromptSpec } from '@/llm/types';
import type { NovelRequirements } from '@/novel/types';
import { maxTokensForChapter } from '@/novel/wordBudget';
import { bullets, joinSections, section, sys, systemBase, user, type StyleExtras } from './base';
import { lengthRule } from './writeChapter';

export type RewriteMode = 'revise' | 'rewrite';

export interface RewriteChapterInput {
  chapterNo: number;
  requirements: NovelRequirements;
  /** Output of `assembleChapterContext().userText` built from the NEW storyline. */
  contextUserText: string;
  oldText: string;
  instructions: string[];
  mode: RewriteMode;
  targetChars: number;
  caps: ProviderCaps;
  style?: StyleExtras;
}

export const REWRITE_MODE_RULE: Record<RewriteMode, string> = {
  revise: '【改写方式】局部修订：尽量保留原文中仍然成立的段落，只改动必要之处，保持原有的叙事节奏与语感。',
  rewrite: '【改写方式】完全重写：按新的章节计划与改写要求重新创作，仅参考原文节奏与篇幅，不要照搬原文段落。',
};

export function rewriteChapterPrompt(input: RewriteChapterInput): PromptSpec<string> {
  const { rule } = lengthRule(input.targetChars, null);
  const system = [systemBase(input.requirements, input.style), rule, REWRITE_MODE_RULE[input.mode]].join('\n');

  const text = joinSections([
    input.contextUserText,
    section('旧版本正文', input.oldText),
    section('改写要求', bullets(input.instructions)),
    section(
      '任务',
      input.mode === 'revise'
        ? `请按改写要求修订第${input.chapterNo}章，输出修订后的完整正文；与要求无关且仍然成立的段落原样保留。`
        : `请按新的本章计划与改写要求重写第${input.chapterNo}章，输出全新的完整正文。`,
    ),
  ]);

  return {
    messages: [sys(system), user(text)],
    maxTokens: maxTokensForChapter(input.targetChars, input.caps),
    temperature: input.mode === 'revise' ? 0.7 : 0.85,
    label: `改写第${input.chapterNo}章`,
  };
}
