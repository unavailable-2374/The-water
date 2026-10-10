import {beforeEach,expect,it} from 'vitest';
import {useTestDb} from '../helpers/testDb';
import {createNovel,updateNovel} from '@/db/repos/novelsRepo';
import {upsertChapterPlan} from '@/db/repos/chaptersRepo';
import {createJob,listSteps} from '@/db/repos/jobsRepo';
import {defaultRequirements} from '@/novel/types';
import {topicMemoryScope} from '@/jobs/topicMemory';
import {saveAuthorNote} from '@/llm/prompts/authorNote';

beforeEach(()=>{useTestDb();});
it('TEST adopted fiction scopes stay stable across chapters and change when the author changes constraints',async()=>{
 const novel=await createNovel({title:'TEST memory scope',premise:'TEST 灯塔故事',requirements:defaultRequirements(),targetChars:10000});
 const a=await upsertChapterPlan(novel.id,{chapterNo:1,title:'TEST 起点',goal:'TEST 登岸',targetChars:1000}),b=await upsertChapterPlan(novel.id,{chapterNo:2,title:'TEST 灯塔',goal:'TEST 寻找',targetChars:2000});
 const job=await createJob({novelId:novel.id,type:'generate_novel',params:{},providerId:null,steps:[{kind:'write_chapter',chapterId:a.id,input:{}},{kind:'write_chapter',chapterId:b.id,input:{}}]});
 const [first,second]=await listSteps(job.id);
 const x=await topicMemoryScope(job,first!,'writing'),y=await topicMemoryScope(job,second!,'writing');
 expect(x?.epoch).toBe(y?.epoch);expect(x?.chapterNo).toBe(1);expect(y?.chapterNo).toBe(2);expect(x?.branchId).toBe('adopted');
 expect((await topicMemoryScope(job,first!,'consistency'))?.channel).toBe('consistency');
 expect(await topicMemoryScope(job,first!,'planning')).toBeUndefined();
 await saveAuthorNote(novel.id,'TEST 不得揭露结局');expect((await topicMemoryScope(job,first!,'writing'))?.epoch).not.toBe(x?.epoch);
 await updateNovel(novel.id,{requirements:{...novel.requirements,docType:'tech-blog'}});expect(await topicMemoryScope(job,first!,'writing')).toBeUndefined();
});
