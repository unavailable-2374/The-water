import { z } from 'zod';
import { EvidenceSchema, anchorEvidence } from '@the-water/shared';
import { sys, user, JSON_ONLY_RULE } from './base';
import { wrapUntrusted, UNTRUSTED_GUARD_RULE } from './untrusted';
import type { PromptSpec } from '@/llm/types';

export const READING_QUESTIONS = {
  goal: '主角现在想得到什么？',
  stakes: '为什么相信这件事对他重要？',
  choice: '为什么采用这种做法，有没有明显更简单的办法？',
  expectation: '对接下来什么事产生期待？',
  understanding: '哪些地方困惑，是否妨碍理解当前场景？',
} as const;
const explanation = z.string().trim().min(1).max(1600);
const quote = z.object({ chapterNo: z.number().int().positive(), quote: z.string().min(1).max(4000) });
const observation = z.object({ interpretation: explanation, confidence: z.enum(['supported', 'tentative', 'unknown']), evidence: z.array(quote).max(8) });
const inferenceCheck = z.object({ claim:explanation, status:z.enum(['supported','tentative','missing_basis']), reason:explanation, evidence:z.array(quote).min(1).max(8), basis:z.array(quote).max(8) });
export const ModelFirstReadingSchema = z.object({
  observations: z.object({ goal: observation, stakes: observation, choice: observation, expectation: observation, understanding: observation }),
  inferenceChecks:z.array(inferenceCheck).max(12),
  confusions: z.array(z.object({ question: explanation, effect: z.enum(['inviting', 'obstructing', 'uncertain']), reason: explanation, evidence: z.array(quote).min(1).max(8) })).max(20),
  preserve: z.array(z.object({ reason: explanation, evidence: z.array(quote).min(1).max(8) })).max(20),
});
const locatedQuote = z.object({ chapterNo: z.number().int().positive(), versionId: z.string().min(1), evidence: EvidenceSchema });
const locatedObservation = observation.extend({ evidence: z.array(locatedQuote).max(8) });
export const FirstReadingSchema = z.object({
  sources: z.array(z.object({ chapterNo: z.number().int().positive(), versionId: z.string().min(1), contentHash: z.string().min(1) })),
  observations: z.object({ goal: locatedObservation, stakes: locatedObservation, choice: locatedObservation, expectation: locatedObservation, understanding: locatedObservation }),
  // Earlier frozen reports remain readable; new calls must provide this separate check.
  inferenceChecks:z.array(inferenceCheck.extend({evidence:z.array(locatedQuote).min(1).max(8),basis:z.array(locatedQuote).max(8)})).max(12).optional(),
  confusions: z.array(ModelFirstReadingSchema.shape.confusions.element.extend({ evidence: z.array(locatedQuote).min(1).max(8) })).max(20),
  preserve: z.array(ModelFirstReadingSchema.shape.preserve.element.extend({ evidence: z.array(locatedQuote).min(1).max(8) })).max(20),
});
export type FirstReading = z.infer<typeof FirstReadingSchema>;
export interface ReadingSource { chapterNo: number; versionId: string; contentHash: string; text: string }
export const ReaderAlignmentSchema = z.array(z.object({
  authorIntent: explanation, readerInference: explanation,
  status: z.enum(['conveyed', 'intentional_open', 'gap', 'uncertain']),
  reason: explanation, suggestion: z.string().max(1600), sourceIds: z.array(z.string().min(1)).max(20),
})).max(20);

export function locateFirstReading(value: z.infer<typeof ModelFirstReadingSchema>, sources: ReadingSource[]): FirstReading {
  const locate = (item: z.infer<typeof quote>) => {
    const source = sources.find(s => s.chapterNo === item.chapterNo);
    if (!source) throw new Error('首次阅读引用了未提供的章节');
    return { chapterNo: item.chapterNo, versionId: source.versionId, evidence: anchorEvidence(source.text, { from: -1, to: -1, quote: item.quote }) };
  };
  const observations = Object.fromEntries(Object.entries(value.observations).map(([key, item]) => [key, { ...item, evidence: item.evidence.map(locate) }]));
  return FirstReadingSchema.parse({ sources: sources.map(({ text: _text, ...s }) => s), observations,
    inferenceChecks:value.inferenceChecks.map(item=>({...item,evidence:item.evidence.map(locate),basis:item.basis.map(locate)})),
    confusions: value.confusions.map(item => ({ ...item, evidence: item.evidence.map(locate) })),
    preserve: value.preserve.map(item => ({ ...item, evidence: item.evidence.map(locate) })),
  });
}
/** Deliberately accepts prose only: no requirements, plans, cards, summaries or author answers. */
export function firstReadingPrompt(sources: ReadingSource[]): PromptSpec<z.infer<typeof ModelFirstReadingSchema>> {
  return {
    messages: [sys(`你是第一次阅读作品的读者，只能依据所附截至当前章的正文，不知道作者资料、未来大纲或秘密答案。逐项回答 observations 的五个问题：${JSON.stringify(READING_QUESTIONS)}。interpretation 记录实际读出了什么；confidence=supported/tentative/unknown 区分明确支持、推测和无法判断；confidence 针对该问题的完整判断，不能因答案中部分动作确实发生就把尚缺依据的部分也标 supported。找不到依据时明确说不知道，不补造心理、经历或作者意图。evidence 仅给 chapterNo 与该章唯一连续逐字 quote，位置由程序计算；supported 必须有证据。confusions 只记录实际存在的疑问，区分吸引继续读的 inviting、阻碍当前理解的 obstructing 与 uncertain；没有疑问返回 []，不得把“未发现困惑”记录为 obstructing，不必为每种 effect 填一条。reason 解释为什么产生该阅读效果，不可只重复分类名。不要求所有心理和秘密立即解释。能辨认目标不等于理解其重要性；stakes 回答为何对这个具体人物重要。亲属称谓、目标名称、反复尝试只能证明目标对象或持续投入；若未呈现个人处境、具体利害、关系经验或价值冲突，不能仅凭这些标签把 stakes 标 supported，要保留 tentative/unknown 并说明缺口。无需一章解释全部背景或列出所有后果；有待解答的问题不等于被吸引。对关键决定或知识变化先做反证检查：原文写出了什么，使这一推断成立；有没有同样符合原文的另一种解释？未得到答复或遭拒绝，不能单独证明对方不知道事实、不是相关参与者或已经说谎；人物可以这样猜，但叙述不能无依据把猜测写成确定的新认识。若新方向依赖这种未经建立的认识，在 confusions 中引用跳跃处并说明缺少哪一步，不用作者将来可能补充的信息消除当前缺口。对宣告的新方向，核对当前行动提供了什么依据，区分读者自己的期待和叙述提出但尚未建立的期待。expectation 写实际想继续读的具体原因，不只复述正文宣告的下一步；区分叙述承诺与读者投入。允许回答不在意、没有期待或上下文不足，不因悬疑题材自动把缺少前因的推断评为 inviting。另以 inferenceChecks 独立核对正文中的关键推断：人物由当前线索获得什么新认识，或据此改变什么行动方向？逐项给 claim、status=supported/tentative/missing_basis、reason，evidence 引用做出推断的原文，basis 引用使推断成立的其他正文依据；缺少依据允许 basis=[]，不能把结论本身重复作为证明。不把“正文说了”当“正文建立了”，也不拿下一步计划当当前认识的证据。至少扫描本章重要行动转折与结尾的新认识；没有关键推断可以 []，不能强造问题。这项证据检查与 confusions 的个人阅读兴趣分开，即使某个谜题吸引你，也需指出其中未被支持的确定推断。preserve 记录应该保留的声音、含蓄、必要歧义、平静互动、普通闲聊、沉默或重复动作意义的变化，必须有原文依据；不因动作重复就推定其意义已经变化或收束已被铺垫。不打分，不作事实校对，不改写；这是 AI 的阅读推断，不是真实读者反馈。\n${UNTRUSTED_GUARD_RULE}\n${JSON_ONLY_RULE}`),
      user(sources.map(s => wrapUntrusted(`第${s.chapterNo}章正文`, s.text)).join('\n\n'))],
    schema: ModelFirstReadingSchema.superRefine((value, check) => {
      for (const [key, item] of Object.entries(value.observations)) if (item.confidence === 'supported' && !item.evidence.length) check.addIssue({ code: 'custom', path: ['observations', key, 'evidence'], message: '已支持的阅读判断必须有正文依据' });
      value.inferenceChecks.forEach((item,i)=>{if(item.status==='supported'&&!item.basis.length)check.addIssue({code:'custom',path:['inferenceChecks',i,'basis'],message:'已支持的推断必须有独立正文依据'});});
      try { locateFirstReading(value, sources); } catch (error) { check.addIssue({ code: 'custom', message: String(error) }); }
    }), maxTokens: 6000, temperature: 0.1, label: '只读正文的首次阅读',
  };
}
