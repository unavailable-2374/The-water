import { z } from 'zod';
import type { PromptSpec } from '@/llm/types';
import { RewriteInstructionsSchema, type RewriteInstructions } from '@/novel/types';
import { JSON_ONLY_RULE, bullets, joinSections, section, sys, user } from './base';

export interface RewritePlanItem {
  chapterNo: number;
  mode: string;
  reasons: string[];
  planText: string;
}

export interface RewritePlanInput {
  diffSummary: string;
  items: RewritePlanItem[];
}

export const REWRITE_MODE_LABEL: Record<string, string> = {
  revise: '局部修订',
  rewrite: '完全重写',
  name_replace: '仅替换名称',
};

export const RewritePlanResponseSchema = z.object({ chapters: RewriteInstructionsSchema });

export const REWRITE_PLAN_JSON_SHAPE = `{ "chapters": [
  { "chapterNo": 1, "instructions": ["本章需要改变：……", "……"] }
] }`;

export function rewritePlanPrompt(input: RewritePlanInput): PromptSpec<{ chapters: RewriteInstructions }> {
  const system = ['你是小说连载的责任编辑。作者修改了故事线，你要把这些改动转化为每一章具体、可执行的中文改写说明。', JSON_ONLY_RULE].join('\n');

  const itemsText = input.items
    .map((it) => {
      const mode = REWRITE_MODE_LABEL[it.mode] ?? it.mode;
      return [
        `第${it.chapterNo}章（${mode}）`,
        it.reasons.length ? `受影响原因：\n${bullets(it.reasons)}` : '',
        it.planText.trim() ? `当前章节计划：\n${it.planText.trim()}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  const rules = [
    `1. 为上面每一章各输出一条记录，chapterNo 与列表一致，共 ${input.items.length} 条，不多不少。`,
    '2. 每章给 2–6 条 instructions，每条以"本章需要改变："开头，说明要改什么、改成什么、为什么；只写与故事线改动相关的内容。',
    '3. "局部修订"的章节只列出必须改动之处；"完全重写"的章节要说明新的走向与保留的要素。',
    '4. 使用简体中文。',
  ].join('\n');

  const text = joinSections([
    section('故事线改动', input.diffSummary),
    section('受影响章节', itemsText),
    section('任务', `请输出每章的改写说明，严格按下面的 JSON 对象结构输出，根对象的 chapters 字段承载改写说明数组。\n${rules}`),
    section('JSON 结构', REWRITE_PLAN_JSON_SHAPE),
  ]);

  return {
    messages: [sys(system), user(text)],
    maxTokens: Math.min(8000, Math.max(1500, 400 * input.items.length + 500)),
    temperature: 0.4,
    schema: RewritePlanResponseSchema,
    label: '生成改写说明',
  };
}
