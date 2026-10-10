import { sha256Hex } from '@the-water/shared';
import { z } from 'zod';
import { ModelEvidenceSchema, locateModelEvidence } from '@/llm/prompts/evidence';
import { reviewForVersion, assertReviewPass } from '@/db/repos/reviewsRepo';
import { chapterDependencies, ExtractionSchema, stageExtraction, listCanonEvents, listWritingCards } from '@/db/repos/writingRepo';
import { requestJson } from '@/llm/json';
import { AwaitingReviewError } from '../awaitingReview';
import type { StepHandler } from '../context';
import { buildChapterContextText, currentVersionOf, loadChapterEnv } from './common';
import { sys, user, JSON_ONLY_RULE } from '@/llm/prompts/base';
import { UNTRUSTED_GUARD_RULE, wrapUntrusted } from '@/llm/prompts/untrusted';

/** Extraction is staged against exact source bytes; only commit_chapter mutates canon. */
export const summarizeStep: StepHandler = async ctx => {
  const env = await loadChapterEnv(ctx), version = await currentVersionOf(env.chapter);
  if (!version) throw new Error('章节尚无正文');
  const deps = await chapterDependencies(env.novel.id, env.chapter.chapterNo);
  const review = await reviewForVersion(version.id);
  if (!review) throw new AwaitingReviewError('缺少必需审查，请先审查此版本');
  await assertReviewPass(review.id, version.id, await sha256Hex(version.content), deps.hash);
  const context = await buildChapterContextText(env, ctx.provider, 6000, { reserved: version.content.length * ctx.provider.caps.cjkTokenRatio });
  const priorEvents=await listCanonEvents(env.novel.id,env.chapter.chapterNo);
  const priorIds=new Set(priorEvents.map(e=>e.id));
  const characterIds=new Set(env.doc.characters.map(c=>c.id));
  const threadIds=new Set((await listWritingCards(env.novel.id,{kind:'thread',confirmed:true})).map(c=>c.id));
  const priorOpenThreads=new Set<string>();
  for(const event of priorEvents) {if(event.threadId && event.kind==='thread_setup') priorOpenThreads.add(event.threadId);if(event.threadId && event.kind==='thread_payoff') priorOpenThreads.delete(event.threadId);}
  const schema=ExtractionSchema.extend({ events: z.array(z.object({ ...ExtractionSchema.shape.events.element.shape, evidence: ModelEvidenceSchema })).max(200) }).superRefine((value,check)=>{
    const seen=new Set(priorIds),open=new Set(priorOpenThreads);
    for(const [i,event] of value.events.entries()) {
      const issue=(field:string,message:string)=>check.addIssue({code:'custom',path:['events',i,field],message});
      if(seen.has(event.id) || event.dependencyIds.some(id=>!seen.has(id))) issue('dependencyIds','id 必须唯一；依赖只能引用已提供的事实或本数组前面的事件 ID，不得循环或引用自身。');
      seen.add(event.id);
      if(event.entityId && !characterIds.has(event.entityId) || event.knownBy.some(id=>!characterIds.has(id))) issue('entityId','只能使用资料中已确认人物的 ID，不能使用名字或自造 ID；未知主体用 null，未知知情者用 []。');
      if (event.perspectiveId && !characterIds.has(event.perspectiveId) || event.relationshipState && (!characterIds.has(event.relationshipState.relatedCharacterId) || event.relationshipState.perspectives.some(p => !characterIds.has(p.characterId)))) issue('perspectiveId', '理解与关系摘要只能引用本书已确认人物');
      if(event.threadId && !threadIds.has(event.threadId) || event.kind.startsWith('thread_') && !event.threadId) issue('threadId','没有已确认伏笔 ID 时必须用普通 event/fact 记录，不得创建 thread_* 事件。');
      if(event.threadId) {
        if(event.kind==='thread_setup') {if(open.has(event.threadId)) issue('kind','该伏笔已经埋设，应记录推进；不要重复埋设。');open.add(event.threadId);}
        if(event.kind==='thread_progress' || event.kind==='thread_payoff') {if(!open.has(event.threadId)) issue('kind','伏笔未埋设或已回收，不得推进或再次回收。');}
        if(event.kind==='thread_payoff') open.delete(event.threadId);
      }
      try {const parsed=ExtractionSchema.shape.events.element.safeParse({...event,evidence:locateModelEvidence(version.content,event.evidence)});if(!parsed.success) for(const problem of parsed.error.issues) issue(problem.path.join("."),problem.message);} catch {issue('evidence','quote 必须是本章正文中唯一的连续逐字原文，不能拼接、省略、改写或引用计划。');}
    }
  });
  const r = await requestJson(ctx.provider, {
    messages: [sys(`你是正文事实记录员。只提取下面已写正文实际发生的事实，不把未来计划当事实。每项另给 epistemic=world_fact/observation/belief/claim 与 perspectiveId（人物理解或证词所属人物，否则 null）。“他没回头”和“她以为他嫌她累赘”分别记录，后者必须 belief，不把谎言、误解或有限视角判断写成世界事实。核心关系发生变化时可在 relationship 事件附 relationshipState：relatedCharacterId、changed、unchanged、perspectives（双方各自 understanding）、interactionLimits。仅为影响下一次互动的少数核心关系维护，依据本章与带来源的前文；不知道的部分明确写未确定，不造经历或强迫和解。摘要是可核对的编辑归纳，必须由事件 evidence 支持。返回 summary 和 events。每项事件包括唯一 id、kind（fact/event/state/relationship/knowledge/thread_setup/thread_progress/thread_payoff）、entityId、threadId、text、knownBy（实际获知的角色 ID）、time、location、dependencyIds（已有事实 ID，或本数组前面的事件 ID；不得前向引用或循环）和 evidence（只返回 quote：唯一的连续逐字原文；不要计算字符位置，程序将定位真实 UTF-16 范围）。人物和伏笔必须使用已确认资料 ID；未知主体留 null；没有已确认伏笔 ID 时只能按普通 fact/event 记录实际事件，不得创建 thread_*。伏笔回收仅能引用已经埋设的同一个 ID。证据必须来自本章正文连续原文。${UNTRUSTED_GUARD_RULE}\n${JSON_ONLY_RULE}`), user(`${context}\n${wrapUntrusted('本章正文', version.content)}`)],
    schema, maxTokens: 6000, temperature: 0.1, label: `提取第${env.chapter.chapterNo}章事实`,
  }, { signal: ctx.signal, gate: ctx.gate });
  await ctx.recordUsage(r.usage);
  const extraction = { ...r.value, events: r.value.events.map(event => ({ ...event, evidence: locateModelEvidence(version.content, event.evidence) })) };
  return { outputRef: await stageExtraction(env.chapter.id, version.id, review.id, deps.hash, extraction) };
};
