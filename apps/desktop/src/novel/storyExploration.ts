import { z } from 'zod';
import { nanoid } from 'nanoid';
import { getDb, now } from '@/db/db';
import { anchorEvidence } from '@the-water/shared';
import { requestStoryJson } from './storyIntelligence';
import { revisionSource } from './structuralRevision';
import { createStoryBranch, saveStoryBranch } from './storyBranches';
import { PLOT_REVIEW_RULE } from './plotDesign';

export const EXPLORATION_GOALS = ['narration', 'relationship', 'expression'] as const;
export type ExplorationGoal = typeof EXPLORATION_GOALS[number];
const text = z.string().trim().min(1).max(6000);
export const ExplorationSchema = z.object({
  candidates: z.array(z.object({ title:text, method:text, readerExperience:text, sample:z.string().min(1).max(30000) })).min(2).max(4),
});
const CausalitySchema = z.object({ status:z.enum(['supported','missing_basis','contradiction']), reason:text, evidence:z.array(z.object({quote:text})).min(1).max(10) });
export const ExplorationAuditSchema = z.object({
  candidates: z.array(z.object({ index:z.number().int().nonnegative(), status:z.enum(['supported','conflict','uncertain']), reason:text,
    evidence:z.array(z.object({quote:text})).min(1).max(10),
    preserve:z.array(text).max(10), loss:z.array(text).max(10),
    // Historical fact-only audits remain readable, but cannot authorize a new branch.
    causality:CausalitySchema.optional(),
  })).min(2).max(4),
  differences:z.array(z.object({left:z.number().int().nonnegative(),right:z.number().int().nonnegative(),axis:text,explanation:text})).min(1).max(12),
});
export interface Exploration { id:string; signature:string; goal:ExplorationGoal; fixedFacts:string; sceneId:string | null; candidates:z.infer<typeof ExplorationSchema>['candidates']; audit:z.infer<typeof ExplorationAuditSchema> }
export async function listStoryExplorations(novelId:string):Promise<Exploration[]> {
  return (await getDb().select<{id:string;json:string}>("SELECT id,json FROM story_suggestions WHERE novel_id=? AND kind='exploration' AND state='pending' ORDER BY created_at DESC",[novelId])).map(r=>({id:r.id,...JSON.parse(r.json)}));
}
/** Independent fact and mechanism audit; human literary preference remains separate. */
export async function auditStoryPresentation(novelId:string,goal:ExplorationGoal,fixedFacts:string,candidates:Exploration['candidates'],signal:AbortSignal) {
  const index=z.number().int().min(0).max(candidates.length-1).describe('原样使用输入样稿的 index；从 0 开始编号，不得改成从 1 开始');
  const mechanismSchema=z.object({candidates:z.array(z.object({index,causality:CausalitySchema})).length(candidates.length)}).superRefine((value,ctx)=>{
    if(new Set(value.candidates.map(c=>c.index)).size!==candidates.length) ctx.addIssue({code:'custom',message:'须逐一核对全部样稿，不重复或遗漏'});
    value.candidates.forEach((item,i)=>{try{item.causality.evidence.forEach(e=>anchorEvidence(candidates[item.index]!.sample,{from:-1,to:-1,quote:e.quote}));}catch(error) { ctx.addIssue({code:'custom',path:['candidates',i],message:`机制证据须来自对应样稿唯一连续原文：${String(error)}`}); }});
  });
  // No author-fixed outcome, titles or intended reader effect: prose must establish its own mechanism.
  const mechanisms=await requestStoryJson(novelId,
    '只看这些正文，不知道作者打算达成什么。逐份检查关键行动与正文声称的结果之间有无实际生效机制。区分人物宣告边界、对方口头承诺、当场行动与长期控制权，不把前三者自动当成最后一项。对关键道具做反事实检验：换成普通替代物后结果还能成立吗，正文有何限制？reason 必须回答此检验并明确实际能支持到哪一步；无机制写 missing_basis，明确与正文条件矛盾写 contradiction，有相应机制且无越界结果才 supported。声明一种愿望而不声称已实现时不误报；不要求阻止一切未来作恶，也不凭留白、平静或个人审美阻断。不得补造稀缺性、制度或历史。每项给 index、causality.status/reason/evidence，使用输入从 0 开始的 index 和对应样稿唯一连续逐字 quote。',
    {candidates:candidates.map(({sample},index)=>({index,sample}))},mechanismSchema,signal,PLOT_REVIEW_RULE,{includeDirection:false});
  const schema = ExplorationAuditSchema.extend({
    candidates:z.array(ExplorationAuditSchema.shape.candidates.element.omit({causality:true}).extend({index})).length(candidates.length),
    differences:z.array(ExplorationAuditSchema.shape.differences.element.extend({left:index,right:index})).min(1).max(12),
  }).superRefine((audit,ctx)=>{
    if(new Set(audit.candidates.map(c=>c.index)).size!==candidates.length) ctx.addIssue({code:'custom',message:'须逐一评阅全部样稿，不重复或遗漏'});
    audit.candidates.forEach((item,i)=>{try {item.evidence.forEach(e=>anchorEvidence(candidates[item.index]!.sample,{from:-1,to:-1,quote:e.quote}));}catch(error) { ctx.addIssue({code:'custom',path:['candidates',i],message:`证据须来自对应样稿唯一连续原文：${String(error)}`}); }});
    audit.differences.forEach((d,i)=>{if(d.left===d.right || !candidates[d.left] || !candidates[d.right]) ctx.addIssue({code:'custom',path:['differences',i],message:'比较须引用两份不同的真实样稿'});});
  });
  const audit=await requestStoryJson(novelId,
    `独立比较这些样稿是否保留 fixedFacts，按本次探索目标比较差异，不要求因果主干不同。逐卡 status=supported/conflict/uncertain 只判断固定事实。原样使用输入中从 0 开始的 index；differences 的 left/right 也用该 index，不得改为从 1 开始编号。给对应样稿的唯一连续逐字 quote，保留原文标点与换行；不要拼接不同句子。preserve 与 loss 分别检查每份样稿自身成立与不足，不只列相对另一稿的差别。结尾把道具或重复动作当成阶段成果时，核对实际争取、代价或意义变化，不能因为道具出现过便赞为余味。含蓄、必要歧义、声音或平静场景不是错误；指出具体损失，不保证真实读者效果。differences 按${goal}目标比较；无法确定是否违背固定事实用 uncertain。`,
    {goal,fixedFacts,candidates:candidates.map((candidate,index)=>({index,...candidate}))},schema,signal,PLOT_REVIEW_RULE,{includeDirection:false});
  return ExplorationAuditSchema.parse({...audit,candidates:audit.candidates.map(c=>({...c,causality:mechanisms.candidates.find(m=>m.index===c.index)!.causality}))});
}
/** Recheck saved candidates without regenerating or overwriting their prose. */
export async function reauditStoryExploration(novelId:string,id:string,signal:AbortSignal) {
  const [row]=await getDb().select<{json:string}>("SELECT json FROM story_suggestions WHERE id=? AND novel_id=? AND kind='exploration' AND state='pending'",[id,novelId]);
  if(!row) throw new Error('探索记录不存在');
  const item=JSON.parse(row.json) as Omit<Exploration,'id'>, source=await revisionSource(novelId);
  if(source.signature!==item.signature) throw new Error('资料已变化，请重新探索');
  const audit=await auditStoryPresentation(novelId,item.goal,item.fixedFacts,item.candidates,signal);
  await getDb().atomic([...source.guards,{sql:"UPDATE story_suggestions SET json=? WHERE id=? AND novel_id=? AND json=? AND state='pending'",params:[JSON.stringify({...item,audit}),id,novelId,row.json],expectedRows:1}]);
}
export async function exploreStoryPresentation(novelId:string, goal:ExplorationGoal, fixedFacts:string, sceneId:string|null, signal:AbortSignal) {
  if (!fixedFacts.trim()) throw new Error('请明确本次必须固定的事件、选择及结局');
  const source = await revisionSource(novelId);
  const scene = source.w.cards.find(c=>c.id===sceneId && c.kind==='scene');
  if (sceneId && !scene) throw new Error('场景不存在');
  // Existing scene outcomes can contradict this exploration's author-fixed boundary.
  // Retain staging and voices, but do not feed old choices/endings as competing instructions.
  const staging=scene?.kind==='scene' ? {id:scene.id,title:scene.data.title,povCharacterId:scene.data.povCharacterId,time:scene.data.time,location:scene.data.location,characterIds:scene.data.characterIds,targetChars:scene.data.targetChars}:null;
  const instruction = goal==='narration' ? '固定同一事实、选择和结局，改变视角、读者知情顺序、时间结构与叙述距离。无需因果主干或高潮机制不同。' : goal==='relationship' ? '固定外部事件，比较双方理解、回应及相处边界；不更改固定事实，允许关系结论不同，但不擅改作者固定结局。' : '固定情节，试写不同对白行动目的、节奏、情绪落点；允许闲聊、直接表达与沉默，不让每句变成潜台词谜题。';
  const boundary=goal==='relationship' ? 'fixedFacts 锁定外部事件及作者明确固定的关系结果；未固定的双方理解、回应、边界及关系结论可以不同，但不能改写固定事件或新造人物经历。' : 'fixedFacts 定义本次事件、选择与结果的完整边界，不能加上未列明的原谅、决裂或其他结果；人物资料仅用于声音与相容的背景，不可借人物弧增加决定或过往事件。';
  const result = await requestStoryJson(novelId, `探索同一件事怎样讲。${instruction}${boundary}动作细节可以使场面成立，但不能新造人物经历。生成 2–4 份具体场面样稿及 method、readerExperience，不输出设计检查清单。所有样稿都是未采纳的虚构创作候选。`, { fixedFacts, staging, authorPreferences:source.w.graph.preferences, characters:source.w.characters, characterIntents:source.w.cards.filter(c=>c.kind==='character' && c.confirmed) }, ExplorationSchema, signal, undefined, {includeDirection:false});
  const audit = await auditStoryPresentation(novelId,goal,fixedFacts,result.candidates,signal);
  if ((await revisionSource(novelId)).signature!==source.signature) throw new Error('生成期间资料变化，请重新探索');
  const id=nanoid();
  await getDb().atomic([...source.guards,{sql:"INSERT INTO story_suggestions(id,novel_id,kind,json,created_at) VALUES (?,?,'exploration',?,?)",params:[id,novelId,JSON.stringify({signature:source.signature,goal,fixedFacts,sceneId,candidates:result.candidates,audit}),now()]}]);
  return id;
}
/** Adoption goes through the existing branch diff/conflict review, never directly into canon. */
export async function explorationToBranch(novelId:string,id:string,index:number) {
  const item=(await listStoryExplorations(novelId)).find(s=>s.id===id), candidate=item?.candidates[index];
  if(!item?.sceneId || !candidate) throw new Error('请选择有已关联场景的样稿');
  if(item.audit.candidates.find(c=>c.index===index)?.status!=='supported') throw new Error('样稿有冲突或尚未确认固定事实，请先修订');
  if(item.audit.candidates.find(c=>c.index===index)?.causality?.status!=='supported') throw new Error('样稿关键行动的因果机制尚未成立或未审查，请先复审或修订');
  if((await revisionSource(novelId)).signature!==item.signature) throw new Error('资料已变化，请重新探索');
  const branch=await createStoryBranch(novelId,item.sceneId,candidate.title);
  return saveStoryBranch(novelId,branch,{name:branch.name,graph:branch.graph,plan:branch.plan,sample:candidate.sample,facts:[],exploration:{goal:item.goal,fixedFacts:item.fixedFacts,reviewedHash:null}});
}

export interface ProseTrial { id:string; proposalId:string; purpose:string; sample:string; uncertainties?:string[]; sourceSignature:string }
export async function listProseTrials(novelId:string):Promise<ProseTrial[]> {
  return (await getDb().select<{id:string;json:string}>("SELECT id,json FROM story_suggestions WHERE novel_id=? AND kind='prose_trial' AND state='pending' ORDER BY created_at DESC",[novelId])).map(r=>({id:r.id,...JSON.parse(r.json)}));
}
/** Before chapters exist, validate 1–3 uncertain scenes straight from a reviewed outline. */
export async function trialOutlineScenes(novelId:string,proposalId:string,purposes:string[],signal:AbortSignal) {
  if(!purposes.length || purposes.length>3 || purposes.some(p=>!p.trim())) throw new Error('请选择一到三个需要正文验证的场面');
  const [row]=await getDb().select<{json:string}>("SELECT json FROM writing_proposals WHERE id=? AND novel_id=? AND state='pending'",[proposalId,novelId]);
  if(!row) throw new Error('待审大纲已变化或已处理');
  const proposal=JSON.parse(row.json), source=await revisionSource(novelId);
  const results=[];
  for(const purpose of purposes) {
    const result=await requestStoryJson(novelId,`依据这份大纲试写最能检验以下不确定效果的一个场面：${purpose}。呈现具体行动、对白与变化，不以概述代替。不需要已建章节，不修改主作品。sample 是未采纳的虚构创作样稿；uncertainties 明确仍无法检验的内容。`, {purpose,outline:proposal.after,cards:proposal.cards},z.object({sample:z.string().min(1).max(30000),uncertainties:z.array(text).max(10)}),signal,undefined,{includeDirection:false});
    const trial={id:nanoid(),proposalId,purpose,...result,sourceSignature:source.signature};
    const [fresh]=await getDb().select<{json:string}>("SELECT json FROM writing_proposals WHERE id=? AND novel_id=? AND state='pending'",[proposalId,novelId]);
    if(fresh?.json!==row.json || (await revisionSource(novelId)).signature!==source.signature) throw new Error('试写期间大纲或资料变化，请重新试写');
    // Each completed response survives a later failure; never save a partial response as a sample.
    await getDb().atomic([...source.guards,{sql:"UPDATE writing_proposals SET id=id WHERE id=? AND novel_id=? AND json=? AND state='pending'",params:[proposalId,novelId,row.json],expectedRows:1},{sql:"INSERT INTO story_suggestions(id,novel_id,kind,json,created_at) VALUES (?,?,'prose_trial',?,?)",params:[trial.id,novelId,JSON.stringify(trial),now()]}]);
    results.push(trial);
  }
  return results;
}
