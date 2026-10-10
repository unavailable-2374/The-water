import type { ProviderCaps, PromptSpec } from '@/llm/types';
import type { NovelRequirements } from '@/novel/types';
import { maxTokensForChapter } from '@/novel/wordBudget';
import { joinSections, section, sys, systemBase, user, type StyleExtras } from './base';

export type LengthAdjustMode = 'expand' | 'trim';

export interface LengthAdjustInput {
  chapterNo: number;
  requirements: NovelRequirements;
  chapterText: string;
  actual: number;
  target: number;
  mode: LengthAdjustMode;
  chapterPlanText: string;
  caps: ProviderCaps;
  style?: StyleExtras;
}

export function lengthAdjustPrompt(input: LengthAdjustInput): PromptSpec<string> {
  const diff = Math.abs(input.target - input.actual);
  const task =
    input.mode === 'expand'
      ? `当前 ${input.actual} 字，目标 ${input.target} 字，需扩写约 ${diff} 字。不改变情节、人物与结局；先检查已有重要选择是否缺少触发、权衡、行动后果，或重要关系是否缺少有意义的互动；只补这些确实缺失且已确认计划支持的内容。过渡与普通操作仍用概述，不重复同一信息、动作、争执或心理说明；不为凑字数增加描写。如果故事已完整而计划不能支持进一步展开，保留合理较短的正文，不编造新经历、事件或提前兑现。输出完整章节。`
      : `当前 ${input.actual} 字，作者要求精简，参考约 ${input.target} 字、减少约 ${diff} 字。在不改变关键情节、人物选择、因果与结局的前提下合并重复动作和同功能对话，删减冗余描写与无效铺陈；保留关键事件、伏笔与结尾钩子，但不需要逐段逐句保留所有细节。字数不是硬上限，不为压到配额删掉必要的铺垫或事件。输出完整章节，不要总结提纲。`;

  const text = joinSections([
    section('本章计划', input.chapterPlanText),
    section('当前正文', input.chapterText),
    section('任务', task),
  ]);

  return {
    messages: [sys(`${systemBase(input.requirements, input.style)}\n当前任务是调整第 ${input.chapterNo} 章的篇幅，参考约 ${input.target} 中文字。${input.mode === 'trim' ? '合并重复表达、删减无效铺陈，保留必要事件；不为压到固定字数删去必要内容。' : '补足确实缺失的事件呈现，不重复已写内容，不为达到配额灌水。'}保留关键事件、因果、人物选择和结尾，不提前兑现其他章节。`), user(text)],
    maxTokens: maxTokensForChapter(input.target, input.caps),
    temperature: 0.6,
    label: `${input.mode === 'expand' ? '扩写' : '精简'}第${input.chapterNo}章`,
  };
}
