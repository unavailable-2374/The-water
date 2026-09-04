import type { PromptSpec } from '@/llm/types';
import { OutlineDocSchema, type NovelRequirements, type OutlineDoc } from '@/novel/types';
import { SettingKind } from '@the-water/shared';
import { joinSections, planningSystem, section, sys, user } from './base';
import { docTypeGuide } from '@/novel/docTypes';
import { isEmptyGenre, mergedGenreOf, type MergedGenre } from '@/novel/genrePacks';

export interface OutlineInput {
  premise: string;
  requirements: NovelRequirements;
  targetChars: number;
  chapterCount: number;
}

export const OUTLINE_JSON_SHAPE = `{
  "title": "书名",
  "logline": "一句话概括全书主线",
  "themes": ["主题1", "主题2"],
  "settings": [{ "name": "设定名", "kind": "${SettingKind.options.join('|')}", "description": "设定说明" }],
  "characters": [{
    "name": "姓名", "aliases": ["别名/称呼"], "role": "主角/反派/配角…", "description": "外貌、性格、背景",
    "arc": "人物在全书中的成长或转变", "relationships": [{ "targetName": "另一位人物的姓名", "kind": "关系类型", "note": "补充说明" }]
  }],
  "arcs": [{ "title": "故事弧标题", "summary": "该弧的核心冲突与走向", "startChapterNo": 1, "endChapterNo": 5 }],
  "beats": [{ "arcIndex": 0, "title": "情节点标题", "summary": "发生了什么、意义何在", "characterNames": ["姓名"], "settingNames": ["设定名"], "suggestedChapterNo": 1 }]
}`;

export function outlinePrompt(input: OutlineInput): PromptSpec<OutlineDoc> {
  const n = Math.max(1, Math.round(input.chapterCount));
  const system = planningSystem('你是一位资深小说策划编辑，擅长把创意框架发展成结构完整、节奏可控的长篇大纲。', input.requirements);

  const rules = [
    `1. 全书约 ${input.targetChars} 字，共 ${n} 章。`,
    '2. title 为书名；logline 用一句话概括主线；themes 给 2–5 个主题。',
    `3. settings 给 3–10 个关键设定，kind 只能取：${SettingKind.options.join('、')}。`,
    '4. characters 给 3–8 位主要人物（可另加少量重要配角），每人写清 role、description、arc；relationships 的 targetName 必须是本列表中另一位人物的 name。',
    `5. arcs 按顺序覆盖第 1 章到第 ${n} 章：连续、不重叠、不留空，第一条 startChapterNo 为 1，最后一条 endChapterNo 为 ${n}。`,
    `6. beats 是全书情节点，每章 1–3 个（总数约 ${n}–${n * 3} 个）；arcIndex 为所属 arcs 的下标（从 0 开始）；suggestedChapterNo 为建议所在章；characterNames / settingNames 只能使用上面给出的 name。`,
    '7. 所有文字使用简体中文；不要输出 JSON 之外的内容。',
  ].join('\n');

  const guide = docTypeGuide(input.requirements.docType);
  const framework = guide.outlineRules.length ? section(`结构框架（${guide.label}：${guide.framework}）`, guide.outlineRules.map((r) => `- ${r}`).join('\n')) : '';
  const genre = guide.fiction ? genreOutlineBlock(mergedGenreOf(input.requirements)) : '';
  const text = joinSections([
    section('故事框架', input.premise),
    framework,
    genre,
    section('任务', `请基于以上框架生成完整大纲，严格按下面的 JSON 结构输出。\n${rules}`),
    section('JSON 结构', OUTLINE_JSON_SHAPE),
  ]);

  return {
    messages: [sys(system), user(text)],
    maxTokens: 8000,
    temperature: 0.7,
    schema: OutlineDocSchema,
    label: '生成大纲',
  };
}

/** 题材层（L1）给大纲的约束：必须落进 settings 的固定条目 + 桥段的用与忌。 */
export function genreOutlineBlock(m: MergedGenre): string {
  if (isEmptyGenre(m)) return '';
  const lines: string[] = [];
  for (const h of m.outlineHints) lines.push(`- ${h}`);
  if (m.entries.length > 0) {
    lines.push(`- 下列题材设定必须写进 settings（kind 取 rule 或 faction），并在全书保持一致：`);
    for (const e of m.entries) lines.push(`  · ${e.name}：${e.description}`);
  }
  if (m.tropes.use.length > 0) lines.push(`- 优先用这些套路：${m.tropes.use.join('；')}`);
  if (m.tropes.avoid.length > 0) lines.push(`- 避开这些烂俗桥段：${m.tropes.avoid.join('；')}`);
  return lines.length > 0 ? section(`题材惯例（${m.labels.join(' + ')}）`, lines.join('\n')) : '';
}
