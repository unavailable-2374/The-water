/**
 * 审校：风格贴合度六维评分 + 逐句 OOC 判定 + 原著事实冲突（docs/writing/templates/fanfic.md「审校 prompt」）。
 */
import { z } from 'zod';
import { anchorEvidence, VOICE_DIMENSIONS, VOICE_DIMENSION_LABEL, type Character, type DerivativeDecl, type StyleProfile } from '@the-water/shared';
import type { PromptSpec } from '@/llm/types';
import { JSON_ONLY_RULE, bullets, joinSections, section, sys, user } from './base';
import { UNTRUSTED_GUARD_RULE, wrapUntrusted } from './untrusted';
import { renderStyleSummary } from './style';

const score = () => z.number().min(0).max(100).catch(70);
export const StyleReviewResultSchema = z.object({
  styleScore: score(),
  dimensionScores: z.object({ narrator: score(), rhythm: score(), imagery: score(), dialogue: score(), humor: score(), emotion: score() }).default({ narrator: 70, rhythm: 70, imagery: 70, dialogue: 70, humor: 70, emotion: 70 }),
  driftFindings: z.array(z.object({ quote: z.string().max(300), dimension: z.string().max(40).default(''), why: z.string().max(300).default(''), suggest: z.string().max(300).default('') })).max(20).default([]),
  ooc: z.array(z.object({ character: z.string().max(50), quote: z.string().max(300), verdict: z.enum(['OOC', 'neutral', 'in-character']).catch('neutral'), redline: z.string().max(200).default(''), why: z.string().max(300).default('') })).max(30).default([]),
  canonConflicts: z.array(z.string().max(300)).max(20).default([]),
  aiTells: z.array(z.string().max(200)).max(20).default([]),
  verdict: z.enum(['pass', 'revise']).catch('pass'),
});
export type StyleReviewResult = z.infer<typeof StyleReviewResultSchema>;

export interface StyleReviewInput {
  chapterNo: number;
  chapterText: string;
  profile: StyleProfile;
  characters: Character[];
  derivative: DerivativeDecl | null;
  sourceTitle: string | null;
  /** Facts / lore lines the chapter must not contradict. */
  canonFacts: string[];
  /** Local metric findings to double-check (already computed). */
  metricHints: string[];
  /** Type-specific QC reminders. */
  qcReminders: string[];
}

export const STYLE_REVIEW_JSON_SHAPE = `{
  "styleScore": 0,
  "dimensionScores": { "narrator": 0, "rhythm": 0, "imagery": 0, "dialogue": 0, "humor": 0, "emotion": 0 },
  "driftFindings": [{ "quote": "原句（逐字）", "dimension": "rhythm", "why": "为什么不像", "suggest": "怎么改" }],
  "ooc": [{ "character": "人物", "quote": "原句（逐字）", "verdict": "OOC|neutral|in-character", "redline": "触碰的红线", "why": "说明" }],
  "canonConflicts": ["与既定事实矛盾之处"],
  "aiTells": ["AI 味的句子或用词"],
  "verdict": "pass|revise"
}`;

export function styleReviewPrompt(input: StyleReviewInput): PromptSpec<StyleReviewResult> {
  const system = [
    '你是原著读者中最挑剔的那一位，也是责任编辑。你只评"像不像原著、人物是否出戏、有没有与既定事实矛盾"，不评故事好坏，不改写。题材包仅为条件性创作指导，不是既定事实；只有本书明确承诺的声音、人物和设定能构成偏离，不能将一般体验建议变成 canonConflicts 或硬性评分要求。',
    UNTRUSTED_GUARD_RULE,
    JSON_ONLY_RULE,
  ].join('\n');
  const dims = VOICE_DIMENSIONS.filter((d) => d !== 'genreConventions').map((d) => `${d}=${VOICE_DIMENSION_LABEL[d]}`).join('，');
  const charLines = input.characters.filter((c) => c.speechSamples.length || c.redlines.length || c.verbalTics.length).map((c) => {
    const parts = [`· ${c.name}`];
    if (c.speechSamples.length) parts.push(`说话样本：${c.speechSamples.slice(0, 4).map((s) => `「${s}」`).join(' ')}`);
    if (c.verbalTics.length) parts.push(`口癖：${c.verbalTics.join('、')}`);
    const ab = Object.entries(c.addressBook);
    if (ab.length) parts.push(`称呼：${ab.map(([k, v]) => `${k}=${v}`).join('，')}`);
    if (c.redlines.length) parts.push(`红线：${c.redlines.join('；')}`);
    return parts.join('｜');
  });
  const rules = [
    `1. styleScore 与 dimensionScores 为 0–100，${dims}；只评风格贴合度，不评内容。`,
    '2. driftFindings 逐句指出明显不像原著的地方，quote 逐字引用，最多 10 条，按严重程度排序。',
    '3. ooc 对每个主要人物的关键对白与行为逐句判定，只列 OOC 与可疑的 neutral，in-character 不用列；触碰红线的必须列出并写明 redline。',
    '4. canonConflicts 对照既定事实与二创声明中"必须保持不变"的条目找矛盾。',
    '5. aiTells 列出明显的 AI 味句子（套话、空洞升华、机械排比）。',
    `6. verdict：styleScore 低于 ${Math.round((input.derivative?.styleFidelity ?? 0.8) * 100)}、或有任何红线 OOC、或有 canonConflicts 时为 revise，否则 pass。`,
  ].join('\n');
  const text = joinSections([
    renderStyleSummary(input.profile),
    input.derivative ? section('二创声明', [input.sourceTitle ? `原著：《${input.sourceTitle}》` : '', input.derivative.mustKeep.length ? `必须保持不变：${input.derivative.mustKeep.join('；')}` : ''].filter(Boolean).join('\n')) : '',
    section('人物言行规格', charLines.join('\n')),
    section('既定事实', bullets(input.canonFacts.slice(0, 30))),
    section('本地统计已发现', bullets(input.metricHints)),
    section('本类型重点', bullets(input.qcReminders)),
    wrapUntrusted(`第${input.chapterNo}章正文`, input.chapterText),
    section('任务', `请审校这一章，严格按下面的 JSON 结构输出。\n${rules}`),
    section('JSON 结构', STYLE_REVIEW_JSON_SHAPE),
  ]);
  const schema=StyleReviewResultSchema.superRefine((value,check)=>{
    value.ooc.forEach((issue,index)=>{
      if(issue.verdict!=='OOC' || !issue.redline.trim()) return;
      try { anchorEvidence(input.chapterText,{from:-1,to:-1,quote:issue.quote}); }
      catch { check.addIssue({code:z.ZodIssueCode.custom,path:['ooc',index,'quote'],message:'阻断问题须引用当前正文唯一可定位的连续逐字原文；重复短句请补充相邻原文'}); }
    });
  });
  return { messages: [sys(system), user(text)], maxTokens: 4000, temperature: 0.2, schema, label: `审校第${input.chapterNo}章` };
}

/** Turn a review + metric findings into revision instructions for rewriteChapterPrompt(mode: 'revise'). */
export function reviewToInstructions(r: StyleReviewResult, metricHints: string[], max = 10): string[] {
  const out: string[] = [];
  for (const h of metricHints) out.push(h);
  for (const o of r.ooc.filter((x) => x.verdict === 'OOC')) out.push(`「${o.quote}」${o.character}出戏${o.redline ? `（红线：${o.redline}）` : ''}${o.why ? '：' + o.why : ''}，改成符合该人物的说法或做法`);
  for (const c of r.canonConflicts) out.push(`与既定事实矛盾：${c}，请改正`);
  for (const d of r.driftFindings) out.push(`「${d.quote}」不像原著${d.why ? '：' + d.why : ''}${d.suggest ? '，建议：' + d.suggest : ''}`);
  for (const a of r.aiTells.slice(0, 3)) out.push(`去掉 AI 味：${a}`);
  return out.slice(0, max);
}
