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
      ? `当前 ${input.actual} 字，目标 ${input.target} 字，需扩写约 ${diff} 字。在不改变情节、人物与结局的前提下扩展描写、对话与心理活动，让场景更充实、节奏更从容；不要新增与本章计划冲突的事件，不要靠重复凑字数。输出完整章节。`
      : `当前 ${input.actual} 字，目标 ${input.target} 字，需精简约 ${diff} 字。在不改变情节、人物与结局的前提下删减冗余描写、重复对话与无效铺陈；保留所有关键事件、伏笔与结尾钩子。输出完整章节。`;

  const text = joinSections([
    section('本章计划', input.chapterPlanText),
    section('当前正文', input.chapterText),
    section('任务', task),
  ]);

  return {
    messages: [sys(systemBase(input.requirements, input.style)), user(text)],
    maxTokens: maxTokensForChapter(input.target, input.caps),
    temperature: 0.6,
    label: `${input.mode === 'expand' ? '扩写' : '精简'}第${input.chapterNo}章`,
  };
}
