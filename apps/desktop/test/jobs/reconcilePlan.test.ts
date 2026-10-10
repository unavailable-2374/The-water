// TEST / SIMULATED chapter plans, not real manuscripts or literary assessments.
import { beforeEach, expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { getDb } from '@/db/db';
import { createNovel } from '@/db/repos/novelsRepo';
import { createVersion, upsertChapterPlan, getVersion } from '@/db/repos/chaptersRepo';
import { createJob, getJob, listSteps, setJobStatus } from '@/db/repos/jobsRepo';
import { defaultRequirements } from '@/novel/types';
import { planGenerate } from '@/jobs/planner';
import { reconcileGenerationPlan } from '@/jobs/reconcilePlan';
beforeEach(()=>useTestDb());
it('TEST whole-book resume retires removed slots and appends adopted chapters without touching prose',async()=>{
 const novel=await createNovel({title:'TEST flexible plan',premise:'TEST premise',requirements:defaultRequirements(),targetChars:9000,status:'planning'});
 const first=await upsertChapterPlan(novel.id,{chapterNo:1,title:'TEST opening',goal:'TEST choice'});
 const slot=await upsertChapterPlan(novel.id,{chapterNo:2});
 const version=await createVersion({chapterId:first.id,content:'TEST protected manuscript',source:'user_edit'});
 const job=await createJob({novelId:novel.id,type:'generate_novel',params:{only:null},providerId:null,steps:planGenerate([first,slot],{force:true})});
 await setJobStatus(job.id,'paused');
 await getDb().execute('UPDATE chapters SET archived_at=1 WHERE id=?',[slot.id]);
 const added=await upsertChapterPlan(novel.id,{chapterNo:3,title:'TEST new ending',goal:'TEST consequence'});
 await reconcileGenerationPlan((await getJob(job.id))!);
 const steps=await listSteps(job.id);
 expect(steps.filter(s=>s.chapterId===slot.id).every(s=>s.status==='skipped')).toBe(true);
 expect(steps.filter(s=>s.chapterId===added.id)).toHaveLength(6);
 expect((await getVersion(version.id))!.content).toBe('TEST protected manuscript');
 expect((await getJob(job.id))!.progress).toMatchObject({total:18,done:6});
 await reconcileGenerationPlan((await getJob(job.id))!);
 expect(await listSteps(job.id)).toHaveLength(18);
});
it('TEST subset delegation cannot acquire newly added chapters',async()=>{
 const novel=await createNovel({title:'TEST subset',premise:'TEST',requirements:defaultRequirements(),targetChars:9000,status:'planning'});
 const chapter=await upsertChapterPlan(novel.id,{chapterNo:1,title:'TEST opening',goal:'TEST choice'});
 const job=await createJob({novelId:novel.id,type:'generate_novel',params:{only:[1]},providerId:null,steps:planGenerate([chapter])});
 await setJobStatus(job.id,'paused');await upsertChapterPlan(novel.id,{chapterNo:2,title:'TEST ending',goal:'TEST'});
 await reconcileGenerationPlan((await getJob(job.id))!);
 expect(await listSteps(job.id)).toHaveLength(6);
});
