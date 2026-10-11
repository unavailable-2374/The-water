import { z } from 'zod';
import { nanoid } from 'nanoid';
import { canonicalJson, sha256Hex, anchorEvidence, ScenePlanSchema } from '@the-water/shared';
import { getDb, now, writeAtomic, type AtomicOperation } from '@/db/db';
import { loadStoryWorkspace } from '@/db/repos/storyGraphRepo';
import { getNovel } from '@/db/repos/novelsRepo';
import { getVersion } from '@/db/repos/chaptersRepo';
import { buildStorylineDoc } from '@/db/repos/storylineRepo';
import { chapterDependencies } from '@/db/repos/writingRepo';
import { listReviews } from '@/db/repos/reviewsRepo';
import { proposeDocumentPlan, type DocumentPlanProposal } from '@/db/repos/planProposalsRepo';
import { requestStoryJson } from './storyIntelligence';
import { createMandate } from './storyMandates';

const text = z.string().trim().min(1).max(4000);
export const StructuralRevisionSchema = z.object({
  problem: text, cause: text, themeQuestion: text,
  evidence: z.array(z.object({ chapterId: z.string().min(1), quote: text })).min(1).max(20),
  alternatives: z.array(z.object({
    title: text, rationale: text, preserve: z.array(text).min(1).max(20), impacts: z.array(text).max(20),
    themeTrajectory: text,
    arcChanges: z.array(z.object({arcId:z.string().min(1),summary:text})).max(20).optional(),
    chapterChanges: z.array(z.object({chapterId:z.string().min(1),goal:text,endHook:text})).max(30).optional(),
    briefEnding: text.nullable().optional(),
    actions: z.array(z.object({ chapterId: z.string().min(1), sceneId: z.string().nullable(), instruction: text, plan: ScenePlanSchema.nullable() })).min(1).max(30),
  })).min(2).max(3),
});
export type StructuralRevision = z.infer<typeof StructuralRevisionSchema>;
export interface RevisionSuggestion { id: string; signature: string; report: StructuralRevision; proposalId?: string; selected?: number; mandateId?: string; baselineProse?: Array<{chapterId:string;versionId:string|null;contentHash:string|null}>; expectedCards?:Array<{id:string;kind:string;data:unknown;chapterId:string|null}> }

/** Snapshot all affected inputs, including uncommitted work, before model work or adoption. */
export async function revisionSource(novelId: string) {
  const novel = await getNovel(novelId);
  if (!novel) throw new Error('作品不存在');
  const w = await loadStoryWorkspace(novelId);
  const doc = await buildStorylineDoc(novelId, novel.premise, novel.meta.themes);
  const prose = await Promise.all(w.chapters.map(async c => ({ chapterId: c.id, chapterNo: c.chapterNo, version: c.currentVersionId ? await getVersion(c.currentVersionId) : null })));
  const dependencies = await Promise.all((w.chapters.length ? w.chapters.map(c=>c.chapterNo) : [0]).map(no => chapterDependencies(novelId, no)));
  const guards: AtomicOperation[] = [...dependencies.map(d=>d.guard), ...prose.map(p=>({
    sql:'UPDATE chapters SET id=id WHERE id=? AND novel_id=? AND current_version_id IS ?',
    params:[p.chapterId,novelId,p.version?.id ?? null],expectedRows:1,
  }))];
  guards.push({sql:'UPDATE novels SET id=id WHERE id=? AND COALESCE((SELECT revision FROM story_graphs WHERE novel_id=?),0)=? AND (SELECT COUNT(*) FROM chapters WHERE novel_id=?)=?',params:[novelId,novelId,w.revision,novelId,w.chapters.length],expectedRows:1});
  // Include unconfirmed cards too: these are supplied to the model, unlike chapterDependencies.
  const cardSnapshot=JSON.stringify(w.cards.map(c=>[c.id,c.revision]).sort((a,b)=>String(a[0])<String(b[0])?-1:String(a[0])>String(b[0])?1:0));
  guards.push({sql:'UPDATE novels SET id=id WHERE id=? AND (SELECT json_group_array(json_array(id,revision)) FROM (SELECT id,revision FROM writing_cards WHERE novel_id=? ORDER BY id))=?',params:[novelId,novelId,cardSnapshot],expectedRows:1});
  const input = { requirements:novel.requirements, doc, graph: w.graph, revision: w.revision, cards: w.cards, prose: prose.map(p => ({ chapterId: p.chapterId, chapterNo: p.chapterNo, versionId: p.version?.id ?? null, contentHash: p.version?.contentHash ?? null, text: p.version?.content ?? '' })), dependencies: dependencies.map(d => d.hash) };
  return { w, doc, prose, dependencies, guards, input, signature: await sha256Hex(canonicalJson(input)) };
}
export async function listStructuralRevisions(novelId: string): Promise<RevisionSuggestion[]> {
  const rows = await getDb().select<{id:string;json:string}>("SELECT id,json FROM story_suggestions WHERE novel_id=? AND kind='structural_revision' AND state='pending' ORDER BY created_at DESC", [novelId]);
  return rows.map(r => ({ id: r.id, ...JSON.parse(r.json), report: StructuralRevisionSchema.parse(JSON.parse(r.json).report) }));
}
export async function proposeStructuralRevision(novelId: string, instruction: string, signal: AbortSignal) {
  const source = await revisionSource(novelId);
  const schema = StructuralRevisionSchema.superRefine((report, ctx) => {
    report.evidence.forEach((e, i) => { try { anchorEvidence(source.prose.find(p => p.chapterId === e.chapterId)?.version?.content ?? '', { from:-1, to:-1, quote:e.quote }); } catch(error) { ctx.addIssue({code:'custom',path:['evidence',i],message:`结构问题必须引用实际章节唯一的连续正文：${String(error)}`}); } });
    report.alternatives.forEach((a,i) => a.actions.forEach((action,j) => {
      const scene = source.w.cards.find(c => c.id === action.sceneId && c.kind === 'scene');
      if (!source.w.chapters.some(c => c.id === action.chapterId) || action.sceneId && scene?.chapterId !== action.chapterId || !action.sceneId && !action.plan) ctx.addIssue({code:'custom',path:['alternatives',i,'actions',j],message:'修改引用已有章节及其场景；新增场景必须给出 plan'});
      if (action.sceneId && source.w.graph.lockedNodeIds.includes(action.sceneId)) ctx.addIssue({code:'custom',path:['alternatives',i,'actions',j],message:'不能修改锁定场景'});
    }));
    report.alternatives.forEach((a,i)=>{
      if(a.arcChanges?.some(c=>!source.w.arcs.some(arc=>arc.id===c.arcId)||source.w.graph.lockedNodeIds.includes(c.arcId)) || a.chapterChanges?.some(c=>!source.w.chapters.some(ch=>ch.id===c.chapterId)||source.w.graph.lockedNodeIds.includes(c.chapterId)))ctx.addIssue({code:'custom',path:['alternatives',i],message:'只能修改本作品未锁定的篇章与章节计划'});
      if(new Set(a.arcChanges?.map(c=>c.arcId)).size!==(a.arcChanges?.length??0)||new Set(a.chapterChanges?.map(c=>c.chapterId)).size!==(a.chapterChanges?.length??0))ctx.addIssue({code:'custom',path:['alternatives',i],message:'同一计划不可重复修改'});
      if(a.chapterChanges?.some(c=>!a.actions.some(action=>action.chapterId===c.chapterId)))ctx.addIssue({code:'custom',path:['alternatives',i,'chapterChanges'],message:'章节计划改动必须包含对应章节的正文处理行动'});
    });
  });
  const report = await requestStoryJson(novelId, `追溯当前问题的前文根因，提出两到三个跨章节结构修订方案。作者关注：${instruction}。区分当前章症状与前文条件，引用实际正文。列出 problem/cause/themeQuestion；每个方案给 rationale、preserve、impacts、themeTrajectory（不同阶段如何回答同一价值问题、选择及仍存在的代价）和 actions。actions 明确章节及场景 ID，instruction 为局部编辑目的；需要改计划时给完整 plan，否则 null；新增场景 sceneId=null 且给 plan。确需修改上层结构时另给 arcChanges（arcId/summary）、chapterChanges（chapterId/goal/endHook）及 briefEnding；无变化用 []/[]/null。这些必须与 actions 对齐，改变结局需要独立大纲复审。不改变未涉及的章节，不擅改人物身世或确认设定，不要求所有关系走向和解。作者选择前不写入主作品。`, { ...source.input, reviews: (await listReviews(novelId)).filter(r => r.valid).map(r => ({ chapterId:r.chapterId, report:r.report })) }, schema, signal);
  if ((await revisionSource(novelId)).signature !== source.signature) throw new Error('生成期间正文或计划已变化，请重新生成结构方案');
  const id = nanoid();
  await getDb().atomic([...source.guards, { sql:"INSERT INTO story_suggestions(id,novel_id,kind,json,created_at) VALUES (?,?,'structural_revision',?,?)", params:[id,novelId,JSON.stringify({signature:source.signature,report}),now()] }]);
  return id;
}
/** Choice stages a plan for the existing review/adoption flow; no prose changes here. */
export async function chooseStructuralRevision(novelId: string, id: string, index: number) {
  const saved = (await listStructuralRevisions(novelId)).find(s=>s.id===id);
  const option = saved?.report.alternatives[index];
  if (!saved || !option) throw new Error('结构方案不存在');
  if (saved.proposalId) return saved.proposalId;
  const source = await revisionSource(novelId);
  if (source.signature !== saved.signature) throw new Error('正文或计划已变化，请重新生成结构方案');
  const cards:NonNullable<Parameters<typeof proposeDocumentPlan>[5]> = option.actions.flatMap(action => {
    if (!action.plan) return [];
    const before = source.w.cards.find(c=>c.id===action.sceneId && c.kind==='scene');
    return [{ id: action.sceneId ?? nanoid(), revision: before?.revision ?? 0, before: before?.kind==='scene' ? {kind:'scene' as const,data:before.data} : null, after:{kind:'scene' as const,data:action.plan},chapterId:action.chapterId,chapterNo:source.w.chapters.find(c=>c.id===action.chapterId)!.chapterNo }];
  });
  const after=structuredClone(source.doc);
  for(const change of option.arcChanges??[]) after.arcs.find(a=>a.id===change.arcId)!.summary=change.summary;
  for(const change of option.chapterChanges??[]) {const chapter=source.w.chapters.find(c=>c.id===change.chapterId)!;const plan=after.chapters.find(c=>c.chapterNo===chapter.chapterNo)!;plan.goal=change.goal;plan.endHook=change.endHook;}
  if(option.briefEnding) {const brief=source.w.cards.find(c=>c.kind==='brief' && c.confirmed);if(brief?.kind!=='brief')throw new Error('需要已确认创作简报才能调整全书结局');cards.push({id:brief.id,revision:brief.revision,before:{kind:'brief',data:brief.data},after:{kind:'brief',data:{...brief.data,ending:option.briefEnding}}});}
  if (new Set(cards.map(c=>c.id)).size !== cards.length) throw new Error('方案对同一场景提供了重复计划，请重新规划');
  const row = (await getDb().select<{json:string}>("SELECT json FROM story_suggestions WHERE id=? AND novel_id=? AND state='pending'",[id,novelId]))[0]!;
  return proposeDocumentPlan(novelId, after, option.title, { structuralRevisionId:id, downstreamImpact:option.impacts, ...((option.arcChanges?.length || option.chapterChanges?.length || option.briefEnding) ? {outlineDone:true,outlineReviewRequired:true,logline:source.doc.premise} : {}) }, undefined, cards, [], async ops => {
    const proposal = ops.find(op=>op.sql.startsWith('INSERT INTO writing_proposals'))!;
    const proposalId = proposal.params![0] as string;
    const baselineProse=source.input.prose.map(({chapterId,versionId,contentHash})=>({chapterId,versionId,contentHash}));
    const expectedCards=[...source.w.cards.filter(c=>!cards.some(change=>change.id===c.id)).map(c=>({id:c.id,kind:c.kind,data:c.data,chapterId:c.chapterId})),...cards.map(c=>({id:c.id,kind:c.after.kind,data:c.after.data,chapterId:c.chapterId??null}))];
    await writeAtomic([...source.guards, ...ops, {sql:"UPDATE story_suggestions SET json=? WHERE id=? AND novel_id=? AND json=? AND state='pending'",params:[JSON.stringify({...JSON.parse(row.json),selected:index,proposalId,baselineProse,expectedCards}),id,novelId,row.json],expectedRows:1}]);
  });
}
/** Author adopts plan first, then explicitly opens evidence-bound chapter edits. */
export async function authorizeStructuralEdits(novelId: string, id: string) {
  const saved = (await listStructuralRevisions(novelId)).find(s=>s.id===id);
  if (!saved?.proposalId || saved.selected === undefined) throw new Error('请先选择并采纳结构计划');
  if (saved.mandateId) return saved.mandateId;
  const [plan] = await getDb().select<{state:string;json:string}>("SELECT state,json FROM writing_proposals WHERE id=? AND novel_id=?",[saved.proposalId,novelId]);
  if (plan?.state !== 'accepted') throw new Error('请先在计划审阅中采纳结构方案');
  const source=await revisionSource(novelId), w=source.w, option = saved.report.alternatives[saved.selected]!;
  if(!saved.baselineProse || canonicalJson(saved.baselineProse)!==canonicalJson(source.input.prose.map(({chapterId,versionId,contentHash})=>({chapterId,versionId,contentHash})))) throw new Error('结构方案选择后正文已变化，请重新审查并生成方案');
  const adopted:DocumentPlanProposal=JSON.parse(plan.json);
  const sortedCards=(cards:NonNullable<RevisionSuggestion['expectedCards']>)=>cards.toSorted((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  if(canonicalJson(source.doc)!==canonicalJson(adopted.after) || !saved.expectedCards || canonicalJson(sortedCards(saved.expectedCards))!==canonicalJson(sortedCards(w.cards.map(c=>({id:c.id,kind:c.kind,data:c.data,chapterId:c.chapterId})))))throw new Error('采纳后计划已变化，请重新生成结构方案');
  const chapters = new Set(option.actions.map(a=>a.chapterId));
  const nodes = w.cards.filter(c=>c.kind==='scene' && c.chapterId && chapters.has(c.chapterId));
  const [row]=await getDb().select<{json:string}>("SELECT json FROM story_suggestions WHERE id=? AND novel_id=? AND state='pending'",[id,novelId]);
  const mandate = await createMandate(novelId,nodes.map(c=>c.id), {must:option.actions.map(a=>`${w.chapters.find(c=>c.id===a.chapterId)?.chapterNo}章：${a.instruction}`).join('\n'),may:option.rationale,mustNot:option.preserve.join('\n')}, async ops=>{
    const mandateId=ops.find(op=>op.sql.startsWith('INSERT INTO story_mandates'))!.params![0];
    await getDb().atomic([...source.guards,...ops,{sql:"UPDATE story_suggestions SET json=? WHERE id=? AND novel_id=? AND json=? AND state='pending'",params:[JSON.stringify({...JSON.parse(row!.json),mandateId}),id,novelId,row!.json],expectedRows:1}]);
  });
  return mandate.id;
}
