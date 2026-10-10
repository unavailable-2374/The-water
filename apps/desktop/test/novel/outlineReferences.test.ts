import { attachSimulatedOutlineReview } from '../helpers/outlineReview';
import { afterEach, describe, expect, it } from 'vitest';
import { OutlineDocSchema, defaultRequirements } from '@/novel/types';
import { requestJson } from '@/llm/json';
import { applyOutline } from '@/novel/planning';
import { createNovel } from '@/db/repos/novelsRepo';
import { acceptDocumentPlan, listDocumentPlans } from '@/db/repos/planProposalsRepo';
import { buildStorylineDoc, listSnapshots } from '@/db/repos/storylineRepo';
import { listWritingCards } from '@/db/repos/writingRepo';
import { useTestDb } from '../helpers/testDb';
import type { CompletionRequest, LLMProvider } from '@/llm/types';

// TEST SIMULATED model responses. No real model-quality claim.
const valid = () => ({ title: 'TEST', logline: 'TEST mainline', themes: [], settings: [], characters: [{name:'TEST name',aliases:['TEST alias']}], arcs: [{title:'TEST arc',startChapterNo:1,endChapterNo:5}], beats:[{title:'TEST beat',arcIndex:0}], writing:{brief:{premise:'TEST premise',mainline:'TEST mainline',ending:'TEST ending',audience:'TEST reader',constraints:[],rollingChapters:5},volumes:[{title:'TEST volume',summary:'TEST summary',startChapterNo:1,endChapterNo:5,arcIndexes:[0]}],intents:[]} });
let db: ReturnType<typeof useTestDb> | undefined;
afterEach(() => {db?.raw.close();db=undefined;});
describe('TEST outline reference validation', () => {
  it('rejects missing arcs, one-based out-of-range indices, and invalid volume ranges', () => {
    for (const edit of [(p:ReturnType<typeof valid>)=>{p.arcs=[];},(p:ReturnType<typeof valid>)=>{p.writing.volumes[0]!.arcIndexes=[1];},(p:ReturnType<typeof valid>)=>{p.writing.volumes[0]!.endChapterNo=0;}]) {
      const p=valid();edit(p);expect(OutlineDocSchema.safeParse(p).success).toBe(false);
    }
    expect(OutlineDocSchema.safeParse(valid()).success).toBe(true);
  });
  it('rejects out-of-range beat references instead of silently dropping them', () => {
    const p=valid();p.beats[0]!.arcIndex=8;
    expect(OutlineDocSchema.safeParse(p).success).toBe(false);
    expect(OutlineDocSchema.safeParse({...valid(),beats:[{title:'TEST beat',arcIndex:null}]}).success).toBe(false);
  });
  it('feeds semantic reference errors back to the model before saving the repaired proposal', async () => {
    db=useTestDb();const broken=valid();broken.arcs=[];
    const requests:CompletionRequest[]=[];
    const provider:LLMProvider={id:'TEST',model:'TEST',kind:'openai_compatible',caps:{contextWindow:32000,maxOutputTokens:8000,jsonMode:'json_schema',cjkTokenRatio:0.7},async *stream(req){requests.push(req);yield {type:'delta',text:JSON.stringify(requests.length===1?broken:valid())};yield {type:'usage',inputTokens:10,outputTokens:20};yield {type:'done',finishReason:'stop'};}};
    const result=await requestJson(provider,{messages:[{role:'user',content:'TEST generate outline'}],label:'TEST',maxTokens:4000,schema:OutlineDocSchema},{retry:false,repairRounds:1});
    expect(requests).toHaveLength(2);expect(requests[1]!.messages.at(-1)!.content).toContain('arcs 是空数组');
    const novel=await createNovel({title:'TEST',premise:'TEST',requirements:defaultRequirements(),targetChars:1000,status:'planning'});
    await applyOutline(novel.id,result.value);
    const p=(await listDocumentPlans(novel.id))[0]!;
    const volume=p.cards!.find(c=>c.after.kind==='volume')!;
    expect(volume.after.kind==='volume'&&volume.after.data.arcIds).toEqual([p.after.arcs[0]!.id]);
  });
  it('resolves an existing character alias for generated motivation cards', async () => {
    db=useTestDb();const p=valid();
    const parsed=OutlineDocSchema.parse({...p,writing:{...p.writing,intents:[{characterName:'TEST alias',goal:'TEST goal',motivation:'TEST motivation',contradiction:'TEST contradiction',growth:[]}]}});
    const novel=await createNovel({title:'TEST',premise:'TEST',requirements:defaultRequirements(),targetChars:1000,status:'planning'});
    await applyOutline(novel.id,parsed);
    expect((await listDocumentPlans(novel.id))[0]!.cards!.some(c=>c.after.kind==='character')).toBe(true);
  });
});

it('TEST reconstruction replaces obsolete draft entities and retires their materials only on adoption',async()=>{
  db=useTestDb();const novel=await createNovel({title:'TEST',premise:'TEST',requirements:defaultRequirements(),targetChars:1000});
  const first=OutlineDocSchema.parse(valid());first.settings=[{name:'TEST obsolete evidence',kind:'item',description:'TEST obsolete'}];
  const oldId=await applyOutline(novel.id,first);await attachSimulatedOutlineReview(novel.id,oldId);await acceptDocumentPlan(novel.id,oldId);
  const old=await buildStorylineDoc(novel.id,novel.premise,[]);const oldVolume=(await listWritingCards(novel.id,{confirmed:true})).find(c=>c.kind==='volume')!;
  const next=valid();next.arcs[0]!.title='TEST new arc';next.beats[0]!.title='TEST new beat';next.writing.volumes[0]!.title='TEST new volume';
  const id=await applyOutline(novel.id,OutlineDocSchema.parse(next));
  expect(await buildStorylineDoc(novel.id,novel.premise,[])).toEqual(old);
  const proposal=(await listDocumentPlans(novel.id)).find(p=>p.id===id)!;expect(proposal.after.arcs).toHaveLength(1);expect(proposal.after.settings).toHaveLength(0);expect(proposal.retiredCards?.some(c=>c.id===oldVolume.id)).toBe(true);
  await attachSimulatedOutlineReview(novel.id,id);await acceptDocumentPlan(novel.id,id);const doc=await buildStorylineDoc(novel.id,novel.premise,[]);expect(doc.arcs.map(a=>a.title)).toEqual(['TEST new arc']);expect(doc.beats.map(b=>b.title)).toEqual(['TEST new beat']);expect(doc.settings).toHaveLength(0);
  expect((await listWritingCards(novel.id,{confirmed:true})).some(c=>c.id===oldVolume.id)).toBe(false);expect((await listWritingCards(novel.id)).some(c=>c.id===oldVolume.id)).toBe(true);
  expect((await listSnapshots(novel.id)).some(s=>JSON.stringify(s.doc)===JSON.stringify(old))).toBe(true);
});
