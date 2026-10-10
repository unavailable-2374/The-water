/** TEST / SIMULATED prose and editorial results; not evidence of literary quality. */
import { beforeEach, expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { testReadyStory } from '../helpers/writing';
import { locateStoryAssessment, storyRevisionIssues } from '@/novel/storyQuality';
import { ChapterReviewJsonSchema, saveReview, assertReviewPass, committedStoryProgress } from '@/db/repos/reviewsRepo';
import { createNovel } from '@/db/repos/novelsRepo';
import { createVersion, upsertChapterPlan, getChapter } from '@/db/repos/chaptersRepo';
import { chapterDependencies, stageExtraction, commitPreparedChapter, invalidateMemoryOperations } from '@/db/repos/writingRepo';
import { getDb } from '@/db/db';
import { defaultRequirements } from '@/novel/types';
import { sha256Hex, type ReviewIssue } from '@the-water/shared';
const text='TEST 她收起清单。她拒绝公开账本。她收起清单。';
const model=()=>({...testReadyStory(),changes:[{kind:'relationship' as const,before:'TEST 控制',after:'TEST 尊重',evidence:{quote:'她拒绝公开账本。'}}],expectations:[{id:'TEST-privacy',question:'TEST 公开吗',response:'TEST 拒绝',status:'paid' as const,evidence:{quote:'她拒绝公开账本。'}}]});
beforeEach(()=>useTestDb());
it('TEST evidence must be unique and real; repeated expectation IDs are rejected',()=>{
 const value=locateStoryAssessment(text,model());
 expect(text.slice(value.changes[0]!.evidence.from,value.changes[0]!.evidence.to)).toBe('她拒绝公开账本。');
 expect(()=>locateStoryAssessment(text,{...model(),changes:[{...model().changes[0]!,evidence:{quote:'她收起清单。'}}]})).toThrow();
 expect(()=>locateStoryAssessment(text,{...model(),changes:[{...model().changes[0]!,evidence:{quote:'TEST missing'}}]})).toThrow();
 expect(()=>locateStoryAssessment(text,{...model(),expectations:[...model().expectations,...model().expectations]})).toThrow('重复的阅读期待 ID');
});
it('TEST fact blockers outrank narrative issues; preferences never trigger repair',()=>{
 const issue=(category:ReviewIssue['category'],severity:ReviewIssue['severity'],id:string):ReviewIssue=>({id,category,severity,evidence:{from:0,to:4,quote:'TEST'},basis:'TEST',suggestion:'TEST',sourceIds:[]});
 const preference=issue('style','suggestion','TEST-style'),plot=issue('motivation','suggestion','TEST-plot'),fact=issue('knowledge','block','TEST-fact');
 expect(storyRevisionIssues([preference,plot,fact],{verdict:'revise'}).map(i=>i.id)).toEqual(['TEST-fact','TEST-plot']);
 expect(storyRevisionIssues([preference,plot],{verdict:'ready'})).toEqual([]);
});
it('TEST editorial revision blocks commit; only committed reviews feed later chapters',async()=>{
 const n=await createNovel({title:'TEST',premise:'TEST',requirements:defaultRequirements(),targetChars:1000});
 const ch=await upsertChapterPlan(n.id,{chapterNo:1});
 const v=await createVersion({chapterId:ch.id,content:text,source:'generated'});
 const deps=await chapterDependencies(n.id,1),hash=await sha256Hex(text);
 const save=(verdict:'ready'|'revise')=>saveReview({novelId:n.id,chapterId:ch.id,chapterVersionId:v.id,styleScore:100,oocCount:0,verdict:'pass',report:ChapterReviewJsonSchema.parse({narrative:[],story:{...locateStoryAssessment(text,model()),verdict}})});
 const unresolved=await save('revise');
 await expect(assertReviewPass(unresolved.id,v.id,hash,deps.hash)).rejects.toThrow('故事推进仍需处理');
 await expect(stageExtraction(ch.id,v.id,unresolved.id,deps.hash,{summary:'TEST',events:[]})).rejects.toThrow('故事推进仍需处理');
 expect((await committedStoryProgress(n.id,2)).expectations).toEqual([]);
 const ready=await save('ready');
 await stageExtraction(ch.id,v.id,ready.id,deps.hash,{summary:'TEST',events:[]});
 expect((await committedStoryProgress(n.id,2)).expectations).toEqual([]);
 await commitPreparedChapter(ch.id,v.id);
 expect((await committedStoryProgress(n.id,2)).expectations).toMatchObject([{id:'TEST-privacy',status:'paid',versionId:v.id}]);
 expect((await committedStoryProgress(n.id,1)).expectations).toEqual([]);
 // A new review of unchanged committed prose replaces the attached assessment, without duplicating commits.
 const updated=await saveReview({novelId:n.id,chapterId:ch.id,chapterVersionId:v.id,styleScore:100,oocCount:0,verdict:'pass',report:ChapterReviewJsonSchema.parse({narrative:[],story:{...locateStoryAssessment(text,model()),expectations:[{...locateStoryAssessment(text,model()).expectations[0]!,response:'TEST refreshed assessment'}]}})});
 await stageExtraction(ch.id,v.id,updated.id,deps.hash,{summary:'TEST',events:[]});
 await commitPreparedChapter(ch.id,v.id);
 expect((await committedStoryProgress(n.id,2)).expectations).toMatchObject([{response:'TEST refreshed assessment',versionId:v.id}]);
 expect((await getChapter(ch.id))!.status).toBe('final');
 await createVersion({chapterId:ch.id,content:'TEST a new unapproved draft',source:'user_edit'});
 expect((await committedStoryProgress(n.id,2)).expectations).toMatchObject([{versionId:v.id}]);
 await getDb().atomic(invalidateMemoryOperations(n.id,1));
 expect((await committedStoryProgress(n.id,2)).expectations).toEqual([]);
});
