/**
 * 一致性审查（按职能拆分的独立审查通道，docs/writing/README.md §3.1）：
 * 只查"事实层"——数值/战力/等级、时间线先后、称呼与辈分、设定规则——不评文风、不评人物是否出戏
 * （那两件事在 styleReview）。低温、只输出 JSON、不改写。
 *
 * 与 styleReview 的分工是按职能而不是按题材：一个通道服务所有题材，题材差异只是喂进来的数据不同。
 */
import { z } from 'zod';
import type { Character } from '@the-water/shared';
import type { PromptSpec } from '@/llm/types';
import { JSON_ONLY_RULE, bullets, joinSections, section, sys, user } from './base';
import { UNTRUSTED_GUARD_RULE, wrapUntrusted } from './untrusted';

const conflict = () => z.object({
  quote: z.string().max(300),
  against: z.string().max(300).default(''),
  why: z.string().max(300).default(''),
});

export const ConsistencyResultSchema = z.object({
  /** 修为/等级/数值/货币/距离与已确立事实矛盾。 */
  numericConflicts: z.array(conflict()).max(20).default([]),
  /** 事件先后、时长、人物所在位置与时间线矛盾。 */
  timelineConflicts: z.array(conflict()).max(20).default([]),
  /** 称呼、辈分、自称用错。 */
  addressErrors: z.array(z.object({
    character: z.string().max(50),
    quote: z.string().max(300),
    expected: z.string().max(80).default(''),
    why: z.string().max(300).default(''),
  })).max(20).default([]),
  /** 与设定规则（题材层或作品层）冲突。 */
  loreConflicts: z.array(conflict()).max(20).default([]),
  verdict: z.enum(['pass', 'revise']).catch('pass'),
});
export type ConsistencyResult = z.infer<typeof ConsistencyResultSchema>;

export interface ConsistencyReviewInput {
  chapterNo: number;
  chapterText: string;
  /** 已确立事实（bible.facts）。 */
  facts: string[];
  /** 设定规则：作品层 settings（kind=rule / constant）+ 题材层 lore 条目。 */
  rules: Array<{ name: string; description: string; scope: '本书' | '题材' }>;
  /** 最近的时间线事件，已带章号。 */
  timeline: string[];
  characters: Array<Pick<Character, 'name' | 'aliases' | 'addressBook'>>;
  /** 题材层 + 文章类型的质检重点。 */
  qcReminders: string[];
}

/** 没有可对照的材料就别浪费一次调用。 */
export function hasConsistencyMaterial(input: Pick<ConsistencyReviewInput, 'facts' | 'rules' | 'timeline' | 'characters'>): boolean {
  const addressable = input.characters.some((c) => Object.keys(c.addressBook).length > 0);
  return input.facts.length >= 3 || input.rules.length > 0 || input.timeline.length > 0 || addressable;
}

export const CONSISTENCY_JSON_SHAPE = `{
  "numericConflicts": [{ "quote": "原句（逐字）", "against": "被违反的事实/设定", "why": "怎么矛盾的" }],
  "timelineConflicts": [{ "quote": "原句（逐字）", "against": "冲突的时间线条目", "why": "说明" }],
  "addressErrors": [{ "character": "人物", "quote": "原句（逐字）", "expected": "应该用的称呼", "why": "说明" }],
  "loreConflicts": [{ "quote": "原句（逐字）", "against": "被违反的设定规则", "why": "说明" }],
  "verdict": "pass|revise"
}`;

export function consistencyReviewPrompt(input: ConsistencyReviewInput): PromptSpec<ConsistencyResult> {
  const system = [
    '你是这本书的设定校对。你只查事实是否自洽：数值与等级、事件先后、称呼与辈分、设定规则。',
    '不评价文笔，不评价人物性格，不评价故事好坏，不改写正文。没有确凿冲突就不要报。',
    UNTRUSTED_GUARD_RULE,
    JSON_ONLY_RULE,
  ].join('\n');

  const ruleLines = input.rules.map((r) => `· [${r.scope}] ${r.name}：${r.description}`);
  const addressLines = input.characters
    .filter((c) => Object.keys(c.addressBook).length > 0)
    .map((c) => `· ${c.name}${c.aliases.length ? `（${c.aliases.join('、')}）` : ''}：${Object.entries(c.addressBook).map(([k, v]) => `${k}→${v}`).join('，')}`);

  const rules = [
    '1. 每条冲突都必须逐字引用正文原句放进 quote，并在 against 写清它违反了哪一条；找不到对应条目就不要报。',
    '2. numericConflicts 只看可核对的量：修为/等级/数量/金额/距离/年龄；模糊描写不算冲突。',
    '3. timelineConflicts 看事件先后、时长、以及人物同一时刻是否出现在两个地方。',
    '4. addressErrors 只在给出了称呼表时判断；表里没写的称呼不算错。',
    '5. loreConflicts 对照设定规则，题材层与本书设定同等有效；本书设定与题材层冲突时以本书为准，不要报。',
    '6. 任何一类有条目时 verdict 为 revise，否则 pass。',
  ].join('\n');

  const text = joinSections([
    section('设定规则', ruleLines.join('\n')),
    section('已确立事实', bullets(input.facts.slice(0, 30))),
    section('时间线（最近）', bullets(input.timeline.slice(-15))),
    section('称呼表', addressLines.join('\n')),
    section('本类型重点', bullets(input.qcReminders.slice(0, 10))),
    wrapUntrusted(`第${input.chapterNo}章正文`, input.chapterText),
    section('任务', `请只做设定校对，严格按下面的 JSON 结构输出。\n${rules}`),
    section('JSON 结构', CONSISTENCY_JSON_SHAPE),
  ]);

  return { messages: [sys(system), user(text)], maxTokens: 2500, temperature: 0.1, schema: ConsistencyResultSchema, label: `校对第${input.chapterNo}章设定` };
}

export function consistencyIssueCount(r: ConsistencyResult): number {
  return r.numericConflicts.length + r.timelineConflicts.length + r.addressErrors.length + r.loreConflicts.length;
}

/** 转成定点修订指令，喂给 rewriteChapterPrompt(mode: 'revise')。 */
export function consistencyToInstructions(r: ConsistencyResult, max = 6): string[] {
  const out: string[] = [];
  for (const c of r.numericConflicts) out.push(`「${c.quote}」与设定矛盾${c.against ? `（${c.against}）` : ''}${c.why ? '：' + c.why : ''}，改成与设定一致的写法`);
  for (const c of r.loreConflicts) out.push(`「${c.quote}」违反设定规则${c.against ? `（${c.against}）` : ''}${c.why ? '：' + c.why : ''}，请改正`);
  for (const c of r.timelineConflicts) out.push(`「${c.quote}」与时间线矛盾${c.against ? `（${c.against}）` : ''}${c.why ? '：' + c.why : ''}，请改正`);
  for (const a of r.addressErrors) out.push(`「${a.quote}」${a.character}的称呼用错${a.expected ? `，应为「${a.expected}」` : ''}`);
  return out.slice(0, max);
}
