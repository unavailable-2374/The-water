/** TEST / SIMULATED outputs. SQLite transactions are real; no human or literary result is fabricated. */
import { beforeEach, expect, it, vi } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { testScene } from '../helpers/writing';
import { createNovel } from '@/db/repos/novelsRepo';
import { createVersion, getChapter, upsertChapterPlan } from '@/db/repos/chaptersRepo';
import { listWritingCards, projectEvents, saveWritingCard } from '@/db/repos/writingRepo';
import { listDocumentPlans, acceptDocumentPlan, proposeDocumentPlan } from '@/db/repos/planProposalsRepo';
import { defaultRequirements } from '@/novel/types';
import { proposeStructuralRevision, listStructuralRevisions, chooseStructuralRevision, authorizeStructuralEdits } from '@/novel/structuralRevision';
import { requestStoryJson } from '@/novel/storyIntelligence';
import { prepareLiteraryReview, listLiteraryReviewPackets, saveHumanLiteraryReview } from '@/novel/literaryEvaluation';
import { exploreStoryPresentation, listStoryExplorations, trialOutlineScenes, listProseTrials, explorationToBranch, reauditStoryExploration } from '@/novel/storyExploration';
import { emptyBible, emptyStoryline, CanonEventSchema } from '@the-water/shared';
vi.mock('@/novel/storyIntelligence',()=>({requestStoryJson:vi.fn()}));
beforeEach(()=>{useTestDb();vi.mocked(requestStoryJson).mockReset();});
async function fixture() {
  const novel=await createNovel({title:'TEST',premise:'TEST fiction',requirements:defaultRequirements(),targetChars:2000});
  const c=await upsertChapterPlan(novel.id,{chapterNo:1,title:'TEST',targetChars:1000});
  await testScene(novel.id,c.id);const card=(await listWritingCards(novel.id)).find(c=>c.kind==='scene')!;
  const v=await createVersion({chapterId:c.id,content:'TEST 她愿意合作，但没有允许他替她签字。',source:'user_edit'});
  return {novel,c,card,v};
}
it('TEST structural alternatives stage a plan before author adoption and chapter edit authorization',async()=>{
  const f=await fixture();
  const alternative={title:'TEST bounded cooperation',rationale:'TEST action before reconciliation',preserve:['TEST autonomy'],impacts:['TEST later contract boundary'],themeTrajectory:'TEST autonomy remains',actions:[{chapterId:f.c.id,sceneId:f.card.id,instruction:'TEST clarify who decides',plan:{...f.card.data,outcome:'TEST preserve signature boundary'}}]};
  const report={problem:'TEST sudden forgiveness',cause:'TEST no costly change',themeQuestion:'TEST autonomy',evidence:[{chapterId:f.c.id,quote:f.v.content}],alternatives:[alternative,{...alternative,title:'TEST understand and leave'}]};
  vi.mocked(requestStoryJson).mockImplementation(async(_n,_i,_s,schema)=>schema.parse(report));
  const id=await proposeStructuralRevision(f.novel.id,'TEST concern',new AbortController().signal);
  expect((await getChapter(f.c.id))!.currentVersionId).toBe(f.v.id);expect(await listDocumentPlans(f.novel.id)).toHaveLength(0);
  const p=await chooseStructuralRevision(f.novel.id,id,0);expect((await listStructuralRevisions(f.novel.id))[0]!.proposalId).toBe(p);
  await expect(authorizeStructuralEdits(f.novel.id,id)).rejects.toThrow('先在计划审阅');
  await acceptDocumentPlan(f.novel.id,p);expect((await getChapter(f.c.id))!.currentVersionId).toBe(f.v.id);
  const mandate=await authorizeStructuralEdits(f.novel.id,id);expect(mandate).toBeTruthy();expect(await authorizeStructuralEdits(f.novel.id,id)).toBe(mandate);
});
it('TEST a stale structural response is rejected rather than attached to edited prose',async()=>{
  const f=await fixture();
  vi.mocked(requestStoryJson).mockImplementation(async()=>{await createVersion({chapterId:f.c.id,content:'TEST edited',source:'user_edit'});return {problem:'TEST',cause:'TEST',themeQuestion:'TEST',evidence:[],alternatives:[]};});
  await expect(proposeStructuralRevision(f.novel.id,'TEST',new AbortController().signal)).rejects.toThrow('生成期间正文');expect(await listStructuralRevisions(f.novel.id)).toEqual([]);
});
it.each(['prose','plan','scene'])('TEST structural authorization rejects %s changes after adoption',async(kind)=>{
  const f=await fixture();
  const alternative={title:'TEST path',rationale:'TEST reason',preserve:['TEST boundary'],impacts:[],themeTrajectory:'TEST autonomy',actions:[{chapterId:f.c.id,sceneId:f.card.id,instruction:'TEST clarify choice',plan:null}]};
  vi.mocked(requestStoryJson).mockImplementation(async(_n,_i,_s,schema)=>schema.parse({problem:'TEST problem',cause:'TEST cause',themeQuestion:'TEST theme',evidence:[{chapterId:f.c.id,quote:f.v.content}],alternatives:[alternative,{...alternative,title:'TEST other path'}]}));
  const id=await proposeStructuralRevision(f.novel.id,'TEST concern',new AbortController().signal);
  const p=await chooseStructuralRevision(f.novel.id,id,0);await acceptDocumentPlan(f.novel.id,p);
  if(kind==='prose')await createVersion({chapterId:f.c.id,content:'TEST changed after plan adoption',source:'user_edit'});
  else if(kind==='plan') await upsertChapterPlan(f.novel.id,{chapterNo:1,title:'TEST changed plan',targetChars:1000});
  else await saveWritingCard(f.novel.id,{kind:'scene',data:{...f.card.data,goal:'TEST changed scene goal'}},{id:f.card.id,chapterId:f.c.id,confirmed:true});
  await expect(authorizeStructuralEdits(f.novel.id,id)).rejects.toThrow('已变化');
  expect((await listStructuralRevisions(f.novel.id))[0]!.mandateId).toBeUndefined();
});
it('TEST prechapter trials retain completed samples when a later model request fails',async()=>{
  const novel=await createNovel({title:'TEST prechapter',premise:'TEST',requirements:defaultRequirements(),targetChars:1000});
  const proposal=await proposeDocumentPlan(novel.id,emptyStoryline(),'TEST outline');
  let calls=0;vi.mocked(requestStoryJson).mockImplementation(async(_n,_i,_s,schema)=>{if(++calls===2)throw new Error('TEST model interrupted');return schema.parse({sample:'TEST completed trial',uncertainties:['TEST attraction remains unverified']});});
  await expect(trialOutlineScenes(novel.id,proposal,['TEST attraction','TEST costly choice'],new AbortController().signal)).rejects.toThrow('TEST model interrupted');
  const trials=await listProseTrials(novel.id);expect(trials).toHaveLength(1);expect(trials[0]?.sample).toBe('TEST completed trial');expect(trials[0]?.uncertainties).toEqual(['TEST attraction remains unverified']);
});
it('TEST beliefs never enter confirmed world facts and relationship summaries retain both sides and limits',()=>{
  const subjective=CanonEventSchema.parse({id:'TEST belief',kind:'fact',entityId:'TEST sister',threadId:null,text:'TEST 她以为他嫌她累赘',epistemic:'belief',perspectiveId:'TEST sister',knownBy:['TEST sister'],time:'',location:'',dependencyIds:[],evidence:{from:0,to:4,quote:'TEST'}});
  expect(projectEvents(emptyBible(),[subjective],1).facts).toEqual([]);
  expect(CanonEventSchema.safeParse({...subjective,perspectiveId:null}).success).toBe(false);
  expect(CanonEventSchema.safeParse({...subjective,kind:'thread_payoff',threadId:'TEST thread'}).success).toBe(false);
  const relation={...subjective,id:'TEST relation',kind:'relationship',epistemic:'observation',relationshipState:{relatedCharacterId:'TEST brother',changed:'TEST cooperation',unchanged:'TEST no signing',perspectives:[{characterId:'TEST sister',understanding:'TEST trial cooperation'},{characterId:'TEST brother',understanding:'TEST assumed forgiveness'}],interactionLimits:'TEST ask before signing'}};
  expect(CanonEventSchema.safeParse(relation).success).toBe(true);
  expect(CanonEventSchema.safeParse({...relation,relationshipState:{...relation.relationshipState,relatedCharacterId:'TEST sister'}}).success).toBe(false);
});
it('TEST fixed-version blind packets omit version identity and author answers, while human feedback stays empty until supplied',async()=>{
  const f=await fixture();const updated=await createVersion({chapterId:f.c.id,content:'TEST 她先问他愿不愿意，然后递过合同。',source:'user_edit'});
  const packet=await prepareLiteraryReview(f.novel.id,f.c.id,'revision_value',f.v.id);
  expect(packet.texts.map(t=>t.label)).toEqual(['X','Y']);expect(packet.texts.map(t=>t.text).sort()).toEqual([f.v.content,updated.content].sort());
  const serialized=JSON.stringify(packet);expect(serialized).not.toContain(f.v.id);expect(serialized).not.toContain(updated.id);expect(packet.materials).toBeUndefined();
  const saved=await listLiteraryReviewPackets(f.novel.id);expect(saved[0]?.state).toBe('awaiting_human');expect(saved[0]?.feedback).toBeNull();
  await expect(saveHumanLiteraryReview(f.novel.id,packet.id,{judgment:'TEST human form validation only',findings:[{label:'X',chapterNo:1,quote:'TEST invented',effect:'improved',reason:'TEST'}]})).rejects.toThrow('missing or ambiguous');
  const first=await prepareLiteraryReview(f.novel.id,f.c.id,'first_reading');expect(first.materials).toBeUndefined();
});
it.each(['narration','relationship','expression'] as const)('TEST %s exploration preserves its own boundary and zero-based audit indexes',async(goal)=>{
  const f=await fixture();let call=0;
  vi.mocked(requestStoryJson).mockImplementation(async(_n,instruction,source,schema)=>{call++;if(call===1){if(goal==='narration')expect(instruction).toContain('无需因果主干');if(goal==='relationship'){expect(instruction).toContain('未固定的双方理解、回应、边界及关系结论可以不同');expect(instruction).not.toContain('不能加上未列明的原谅');}expect(source).not.toHaveProperty('scene');expect(source).not.toHaveProperty('graph');expect(source).toHaveProperty('staging');return schema.parse({candidates:[{title:'TEST sister POV',method:'TEST limited sister',readerExperience:'TEST concern',sample:'TEST 她把合同推回去。'},{title:'TEST brother POV',method:'TEST limited brother',readerExperience:'TEST misunderstanding',sample:'TEST 他等着她签字。'}]});}if(call===2){expect(source).not.toHaveProperty('fixedFacts');expect(source).not.toHaveProperty('goal');expect(source).not.toHaveProperty('candidates.0.readerExperience');return schema.parse({candidates:[0,1].map(index=>({index,causality:{status:'supported',reason:'TEST refusal is not a guaranteed future constraint',evidence:[{quote:index===0?'TEST 她把合同推回去。':'TEST 他等着她签字。'}]}}))});}expect(source).toHaveProperty('candidates.0.index',0);expect(source).toHaveProperty('candidates.1.index',1);return schema.parse({candidates:[0,1].map(index=>({index,status:'supported',reason:'TEST same facts',causality:{status:'supported',reason:'TEST refusal explicitly stated',evidence:[{quote:index===0?'TEST 她把合同推回去。':'TEST 他等着她签字。'}]},evidence:[{quote:index===0?'TEST 她把合同推回去。':'TEST 他等着她签字。'}],preserve:['TEST ambiguity'],loss:[]})),differences:[{left:0,right:1,axis:'TEST viewpoint',explanation:'TEST different information'}]});});
  await exploreStoryPresentation(f.novel.id,goal,'TEST she refuses to sign',f.card.id,new AbortController().signal);
  expect(await listStoryExplorations(f.novel.id)).toHaveLength(1);expect((await getChapter(f.c.id))!.currentVersionId).toBe(f.v.id);
});

it.each(['missing_basis','contradiction','legacy'] as const)('TEST fact preservation does not permit a %s mechanism to stage a branch',async(status)=>{
  const f=await fixture();
  const {getDb}=await import('@/db/db');
  const {revisionSource}=await import('@/novel/structuralRevision');
  const source=await revisionSource(f.novel.id);
  const sample='TEST 她收回普通笔，因此他再也不能代签。';
  const auditItem={index:0,status:'supported',reason:'TEST fixed event retained',evidence:[{quote:sample}],preserve:[],loss:[],...(status==='legacy'?{}:{causality:{status,reason:'TEST ordinary substitute available',evidence:[{quote:sample}]}})};
  await getDb().execute("INSERT INTO story_suggestions(id,novel_id,kind,json,created_at) VALUES (?,?,'exploration',?,?)",['TEST-audit',f.novel.id,JSON.stringify({signature:source.signature,goal:'narration',fixedFacts:'TEST she takes pen',sceneId:f.card.id,candidates:[{title:'TEST',method:'TEST',readerExperience:'TEST',sample}],audit:{candidates:[auditItem],differences:[]}}),1]);
  await expect(explorationToBranch(f.novel.id,'TEST-audit',0)).rejects.toThrow('因果机制');
  expect(await getDb().select("SELECT id FROM story_branches WHERE novel_id=?",[f.novel.id])).toHaveLength(0);
  expect((await getChapter(f.c.id))!.currentVersionId).toBe(f.v.id);
});
it('TEST reaudit preserves saved prose and rejects invented causal evidence',async()=>{
  const f=await fixture();let call=0;
  const samples=['TEST 她明确拒绝代签。','TEST 他等她本人签字。'];
  const audit=(bad=false)=>({candidates:samples.map((sample,index)=>({index,status:'supported',reason:'TEST facts',evidence:[{quote:sample}],causality:{status:'supported',reason:'TEST no claim to stop all forgery',evidence:[{quote:bad?'TEST invented mechanism':sample}]},preserve:[],loss:['TEST unearned motif (advisory only)']})),differences:[{left:0,right:1,axis:'TEST viewpoint',explanation:'TEST'}]});
  vi.mocked(requestStoryJson).mockImplementation(async(_n,_i,_s,schema)=>schema.parse(++call===1?{candidates:samples.map(sample=>({title:'TEST',method:'TEST',readerExperience:'TEST',sample}))}:audit()));
  const id=await exploreStoryPresentation(f.novel.id,'narration','TEST refusal only',f.card.id,new AbortController().signal);
  vi.mocked(requestStoryJson).mockImplementation(async(_n,_i,_s,schema)=>schema.parse(audit(true)));
  await expect(reauditStoryExploration(f.novel.id,id,new AbortController().signal)).rejects.toThrow('证据须来自');
  vi.mocked(requestStoryJson).mockImplementation(async(_n,_i,_s,schema)=>schema.parse(audit()));
  await reauditStoryExploration(f.novel.id,id,new AbortController().signal);
  expect((await listStoryExplorations(f.novel.id))[0]!.candidates.map(c=>c.sample)).toEqual(samples);
  await expect(explorationToBranch(f.novel.id,id,0)).resolves.toBeDefined();
  expect((await getChapter(f.c.id))!.currentVersionId).toBe(f.v.id);
});
