import type { ProviderCaps, PromptSpec } from '@/llm/types';
import type { NovelRequirements } from '@/novel/types';
import { askedTarget, maxTokensForChapter, minAcceptable } from '@/novel/wordBudget';
import { joinSections, section, sys, systemBase, user, type StyleExtras } from './base';

export type ChapterHalf = 'first' | 'second';

export interface WriteChapterInput {
  chapterNo: number;
  requirements: NovelRequirements;
  /** Output of `assembleChapterContext().userText`. */
  contextUserText: string;
  /** Full-chapter target (even when writing a half). */
  targetChars: number;
  half?: ChapterHalf | null;
  firstHalfText?: string;
  caps: ProviderCaps;
  style?: StyleExtras;
}

export function lengthRule(targetChars: number, half: ChapterHalf | null | undefined): { rule: string; partTarget: number } {
  const asked = askedTarget(targetChars);
  const min = minAcceptable(targetChars);
  if (!half) {
    return {
      rule: `【篇幅】本章目标约 ${asked} 字（严格），不得少于 ${min} 字，不要为了凑字数而重复。`,
      partTarget: targetChars,
    };
  }
  const partTarget = Math.round(targetChars / 2);
  const partAsked = askedTarget(partTarget);
  const partMin = minAcceptable(partTarget);
  const which = half === 'first' ? '前半部分' : '后半部分';
  return {
    rule: `【篇幅】本章总目标约 ${asked} 字，本次只写${which}，约 ${partAsked} 字（严格），不得少于 ${partMin} 字，不要为了凑字数而重复。`,
    partTarget,
  };
}

export function writeChapterPrompt(input: WriteChapterInput): PromptSpec<string> {
  const half = input.half ?? null;
  const { rule, partTarget } = lengthRule(input.targetChars, half);
  const system = `${systemBase(input.requirements, input.style)}\n${rule}`;

  let task: string;
  if (half === 'first') {
    task = `请撰写第${input.chapterNo}章的前半部分：从本章开头写起，推进约一半的情节点，在一个自然的场景转折处停笔；不要写到结尾钩子，不要总结。`;
  } else if (half === 'second') {
    task = `请续写第${input.chapterNo}章的后半部分：直接接续前半部分的最后一句，不要重复前文，不要重新开头；完成剩余情节点，并落到本章的结尾钩子。`;
  } else {
    task = `请撰写第${input.chapterNo}章的完整正文，覆盖本章计划中的全部情节点，并以结尾钩子收束。`;
  }

  const text = joinSections([
    input.contextUserText,
    half === 'second' ? section('本章前半部分', input.firstHalfText ?? '') : '',
    section('任务', task),
  ]);

  return {
    messages: [sys(system), user(text)],
    maxTokens: maxTokensForChapter(partTarget, input.caps),
    temperature: 0.85,
    label: `撰写第${input.chapterNo}章`,
  };
}
