/** TEST / SIMULATED model responses; tests prove isolation and provenance, not literary quality. */
import { beforeEach, expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { testFirstReading, testScene } from '../helpers/writing';
import { createNovel } from '@/db/repos/novelsRepo';
import { createVersion, upsertChapterPlan } from '@/db/repos/chaptersRepo';
import { getDb } from '@/db/db';
import { defaultRequirements } from '@/novel/types';
import { readProseOnly } from '@/novel/firstReading';
import { firstReadingPrompt, locateFirstReading, ModelFirstReadingSchema } from '@/llm/prompts/firstReading';
import { emptyStoryline } from '@the-water/shared';
import { narrativeReviewPrompt } from '@/llm/prompts/narrativeReview';
import { sceneTypeOf } from '@/jobs/steps/common';
import type { CompletionRequest, LLMProvider } from '@/llm/types';
beforeEach(()=>useTestDb());
it('TEST complete committed prose reaches first reading, but future prose, summaries and author answers do not',async()=>{
  const novel=await createNovel({title:'TEST secret title',premise:'TEST hidden answer',requirements:defaultRequirements(),targetChars:3000});
  const chapters=[];
  for(let n=1;n<=3;n++) {const c=await upsertChapterPlan(novel.id,{chapterNo:n,title:`TEST plan ${n}`,goal:'TEST hidden motive',targetChars:1000});await testScene(novel.id,c.id);chapters.push(c);}
  const prior=await createVersion({chapterId:chapters[0]!.id,content:'TEST 前文🌊。她保留了父亲的收音机。',source:'user_edit',summary:'TEST hidden summary'});
  await getDb().execute("UPDATE chapters SET committed_version_id=?,memory_status='valid' WHERE id=?",[prior.id,chapters[0]!.id]);
  const current=await createVersion({chapterId:chapters[1]!.id,content:'TEST 他没有回头。她以为他嫌她累赘。',source:'user_edit'});
  await createVersion({chapterId:chapters[2]!.id,content:'TEST FUTURE SECRET',source:'user_edit'});
  const requests:CompletionRequest[]=[];
  const value=ModelFirstReadingSchema.parse(testFirstReading());value.observations.stakes={interpretation:'TEST SIMULATED retaining attachment',confidence:'supported',evidence:[{chapterNo:1,quote:'她保留了父亲的收音机。'}]};
  const provider:LLMProvider={id:'TEST',kind:'openai_compatible',model:'TEST',caps:{contextWindow:128000,maxOutputTokens:10000,jsonMode:'json_object',cjkTokenRatio:0.7},async *stream(request){requests.push(request);yield {type:'delta',text:JSON.stringify(value)};yield {type:'done',finishReason:'stop'};}};
  const result=await readProseOnly(novel.id,2,current,provider,{signal:new AbortController().signal});
  const prompt=JSON.stringify(requests[0]!.messages);
  expect(prompt).toContain(prior.content);expect(prompt).toContain(current.content);
  for(const hidden of ['TEST hidden answer','TEST hidden motive','TEST hidden summary','TEST FUTURE SECRET','TEST plan']) expect(prompt).not.toContain(hidden);
  expect(result.reading.sources.map(s=>s.versionId)).toEqual([prior.id,current.id]);
  expect(result.reading.observations.stakes.evidence[0]?.evidence.quote).toBe('她保留了父亲的收音机。');
  const aligned=narrativeReviewPrompt({chapterNo:2,text:current.content,context:'TEST author answer',firstReading:result.reading});
  expect(aligned.messages[1]!.content).toContain('TEST author answer');expect(aligned.messages[1]!.content).toContain('intentional_open');
  expect(aligned.schema!.safeParse({}).success).toBe(false);
});
it('TEST no excerpt or summary fallback when earlier prose is absent or the full reading overflows',async()=>{
  const novel=await createNovel({title:'TEST',premise:'TEST',requirements:defaultRequirements(),targetChars:2000});
  await upsertChapterPlan(novel.id,{chapterNo:1,title:'TEST',targetChars:1000});
  const provider:LLMProvider={id:'TEST',kind:'openai_compatible',model:'TEST',caps:{contextWindow:500,maxOutputTokens:10000,jsonMode:'json_object',cjkTokenRatio:0.7},async *stream(){throw new Error('TEST model must not be called');}};
  await expect(readProseOnly(novel.id,2,{id:'TEST current',content:'TEST 当前章'},provider,{signal:new AbortController().signal})).rejects.toThrow('已提交的正文');
  await expect(readProseOnly(novel.id,1,{id:'TEST current',content:'TEST 当前章'},provider,{signal:new AbortController().signal})).rejects.toThrow('完整正文超出');
});
it('TEST quotes cannot point at plans, repeated text or invented chapters',()=>{
  const sources=[{chapterNo:1,versionId:'TEST v1',contentHash:'TEST hash',text:'TEST 重复，重复'}];
  const v={...testFirstReading(),confusions:[{question:'TEST question',effect:'uncertain' as const,reason:'TEST uncertain',evidence:[{chapterNo:1,quote:'重复'}]}]};
  expect(()=>locateFirstReading(v,sources)).toThrow('missing or ambiguous');
  expect(firstReadingPrompt(sources).schema!.safeParse({...v,confusions:[{...v.confusions[0],evidence:[{chapterNo:2,quote:'TEST'}]}]}).success).toBe(false);
});
it('TEST scene purpose overrides first/last chapter position for exemplar selection',async()=>{
  const novel=await createNovel({title:'TEST',premise:'TEST fiction',requirements:defaultRequirements(),targetChars:2000});
  const chapter=await upsertChapterPlan(novel.id,{chapterNo:1,title:'TEST first',targetChars:1000});
  const last=await upsertChapterPlan(novel.id,{chapterNo:2,title:'TEST last',targetChars:1000});
  await testScene(novel.id,chapter.id);
  const { listWritingCards }=await import('@/db/repos/writingRepo');
  const card=(await listWritingCards(novel.id)).find(c=>c.kind==='scene')!;
  if(card.kind!=='scene')throw new Error('TEST missing scene');
  const env={chapter,doc:emptyStoryline(),chapters:[chapter,last]};
  const scene={...card.data,goal:'TEST 试探与争取',obstacle:'TEST 沉默',turn:'TEST 拒绝',outcome:'TEST 新边界'};
  expect(sceneTypeOf(env,scene)).toBe('dialogue');expect(sceneTypeOf(env)).toBe('opening');
});

it('TEST inferred knowledge has its own located evidence, never a self-proving conclusion or invented basis',()=>{
  const sources=[{chapterNo:1,versionId:'TEST v',contentHash:'TEST hash',text:'TEST 他不愿答复。她断定他从未到场。'}];
  const inference={claim:'TEST unwillingness does not prove absence',status:'missing_basis' as const,reason:'TEST no attendance evidence',evidence:[{chapterNo:1,quote:'她断定他从未到场。'}],basis:[]};
  const value={...testFirstReading(),inferenceChecks:[inference]};
  expect(locateFirstReading(value,sources).inferenceChecks?.[0]?.evidence[0]?.versionId).toBe('TEST v');
  expect(firstReadingPrompt(sources).schema!.safeParse({...value,inferenceChecks:[{...inference,status:'supported'}]}).success).toBe(false);
  expect(firstReadingPrompt(sources).schema!.safeParse({...value,inferenceChecks:[{...inference,basis:[{chapterNo:2,quote:'TEST invented evidence'}]}]}).success).toBe(false);
});
