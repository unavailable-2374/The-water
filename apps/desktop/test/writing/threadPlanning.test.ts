/** TEST fixtures; no real manuscript or model results. */
import { expect, it } from 'vitest';
import { StoryThreadSchema } from '@the-water/shared';
import { pendingChapterBatches, chapterTablePrompt } from '@/llm/prompts/chapterTable';
import { defaultRequirements, OutlineDocSchema } from '@/novel/types';
import { plannedThreadCards, threadRelevantAt } from '@/novel/threadPlanning';
import { assertJobMayResume, canSupplementPlan } from '@/jobs/planningAdmission';

const thread={title:'TEST letter',setup:'TEST date',progression:'TEST compare',payoff:'TEST explain',plannedChapterNo:90,characterIds:[],milestones:[{chapterNo:6,kind:'setup' as const,detail:'TEST question'},{chapterNo:45,kind:'progress' as const,detail:'TEST clue'},{chapterNo:90,kind:'payoff' as const,detail:'TEST answer'}]};
it('TEST sparse known chapters survive missing-range batching',()=>{
  expect(pendingChapterBatches(100,new Set([1,2,3,4,5,50]))).toEqual([[6,35],[36,49],[51,80],[81,100]]);
  expect(pendingChapterBatches(100,new Set(Array.from({length:100},(_,i)=>i+1)))).toEqual([]);
});
it('TEST validates stage order and preserves undated legacy threads',()=>{
  expect(StoryThreadSchema.safeParse(thread).success).toBe(true);
  expect(StoryThreadSchema.safeParse({...thread,milestones:undefined}).success).toBe(true);
  expect(StoryThreadSchema.safeParse({...thread,milestones:[thread.milestones[2],thread.milestones[1],thread.milestones[0]]}).success).toBe(false);
  expect(StoryThreadSchema.safeParse({...thread,plannedChapterNo:45}).success).toBe(false);
});
it('TEST permits appropriate early payoffs and no mystery threads without imposing chapter quotas',()=>{
  const spec=chapterTablePrompt({outline:OutlineDocSchema.parse({logline:'TEST mainline',characters:[],arcs:[{title:'TEST arc',startChapterNo:1,endChapterNo:100}],beats:[]}),requirements:defaultRequirements(),planThreads:true,fromChapter:6,toChapter:35,totalChapters:100,batchTotalChars:90000,minChars:1800,maxChars:4500,previousEntries:[]});
  const chapters=Array.from({length:30},(_,i)=>({chapterNo:i+6,title:'TEST chapter',goal:'TEST goal',targetChars:3000,endHook:'TEST hook',beatTitles:[],povCharacter:null}));
  const short={...thread,characterNames:[],plannedChapterNo:35,milestones:[{chapterNo:6,kind:'setup',detail:'TEST question'},{chapterNo:20,kind:'progress',detail:'TEST clue'},{chapterNo:35,kind:'payoff',detail:'TEST answer'}]};
  expect(spec.schema!.safeParse({chapters,threads:[short]}).success).toBe(true);
  expect(spec.schema!.safeParse({chapters,threads:[]}).success).toBe(true);
  expect(spec.schema!.safeParse({chapters,threads:[{...thread,characterNames:[]}]}).success).toBe(true);
});
it('TEST retrieves scheduled threads before scene association and resolves stable character IDs',()=>{
  expect([5,6,44,45,90,91].map(n=>threadRelevantAt(thread,n))).toEqual([false,true,true,true,true,false]);
  expect(threadRelevantAt({...thread,milestones:undefined},6)).toBe(false);
  const card=plannedThreadCards([{...thread,characterNames:['TEST alias']}],[{id:'TEST stable id',name:'TEST author',aliases:['TEST alias']}])[0]!;
  expect(card.kind==='thread' && card.data.characterIds).toEqual(['TEST stable id']);
  expect(()=>plannedThreadCards([{...thread,characterNames:['TEST unknown']}],[])).toThrow('不存在的人物');
});
it('TEST permits supplemental planning only beside explicitly paused prose',()=>{
  const writing={id:'TEST writing',status:'paused' as const,params:{}};
  const planning={id:'TEST planning',status:'awaiting_review' as const,params:{stage:'plan',fillMissing:true}};
  expect(canSupplementPlan([writing])).toBe(true);
  expect(canSupplementPlan([{...writing,status:'running'}])).toBe(false);
  expect(canSupplementPlan([writing,planning])).toBe(false);
  expect(()=>assertJobMayResume(writing,[writing,planning])).toThrow('先审阅');
  expect(()=>assertJobMayResume({...planning,status:'paused'},[writing,planning])).not.toThrow();
  expect(()=>assertJobMayResume(writing,[writing,{...planning,status:'completed'}])).not.toThrow();
});

// TEST checkpoints: no real writing jobs or model data.
it('TEST outline-based planning resumes at prose checkpoints while writing stays blocked', () => {
  const writing = { id: 'TEST prose', status: 'awaiting_review' as const, params: {} };
  const planning = { id: 'TEST planning', status: 'paused' as const, params: { stage: 'plan', replanAfterOutline: true } };
  expect(canSupplementPlan([writing])).toBe(true);
  expect(() => assertJobMayResume(planning, [writing, planning])).not.toThrow();
  expect(() => assertJobMayResume(writing, [writing, planning])).toThrow('先审阅');
  expect(canSupplementPlan([writing, { ...planning, status: 'awaiting_review' }])).toBe(false);
});
