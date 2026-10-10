/** TEST SIMULATED prerequisites. No model calls or user data. */
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
// TEST scheduler disabled: verify queue transactions and rendering without model execution.
vi.mock('@/jobs/runner',()=>({kick:vi.fn(),cancelJob:vi.fn(),canActOnStep:vi.fn(),pauseJob:vi.fn(),resumeJob:vi.fn(),retryStep:vi.fn(),skipFailedStep:vi.fn(),skipStep:vi.fn()}));
import { useTestDb } from '../helpers/testDb';
import { createNovel } from '@/db/repos/novelsRepo';
import { defaultRequirements } from '@/novel/types';
import { upsertChapterPlan,createVersion,getChapter } from '@/db/repos/chaptersRepo';
import { createJob,listSteps,getJob,setJobStatus,stepFailed,updateProgress } from '@/db/repos/jobsRepo';
import { prepareJobMemoryRepair } from '@/db/repos/jobMemoryRepair';
import { recoverAcceptedPlanJobs } from '@/db/repos/planJobCompletion';
import { saveWritingCard } from '@/db/repos/writingRepo';
import { jobAwaitingAction,jobAwaitingLabel,jobReviewPath } from '@/jobs/presentation';
import { t } from '@/i18n';
import { loadChapterEnv } from '@/jobs/steps/common';
import type { StepContext } from '@/jobs/context';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { JobControls } from '@/features/studio/JobsTab';
import { useJobs } from '@/stores/jobsStore';
let db:ReturnType<typeof useTestDb>;
beforeEach(()=>{db=useTestDb();});afterEach(()=>{db.raw.close();useJobs.setState({jobs:{},steps:{}});});
async function fixture(){
  const novel=await createNovel({title:'TEST SIMULATED',premise:'TEST',targetChars:1000,requirements:defaultRequirements()});
  const chapters=[];
  for(let n=1;n<=4;n++)chapters.push(await upsertChapterPlan(novel.id,{chapterNo:n,title:`TEST ${n}`}));
  for(const c of chapters.slice(0,3)){
    const version=await createVersion({chapterId:c.id,content:'TEST SIMULATED prose',source:'user_edit'});
    await db.execute("UPDATE chapters SET committed_version_id=?,memory_status='stale' WHERE id=?",[version.id,c.id]);
  }
  const job=await createJob({novelId:novel.id,type:'generate_novel',params:{},providerId:null,steps:[{kind:'scene_plan',chapterId:chapters[3]!.id},{kind:'write_scenes',chapterId:chapters[3]!.id}]});
  const step=(await listSteps(job.id))[0]!;
  const error='第 1 章记忆尚未重建，请按顺序审查并提交前文';
  await stepFailed(step.id,error);await setJobStatus(job.id,'awaiting_review',{error});await updateProgress(job.id,{currentStepId:step.id,message:error});
  return {novel,chapters,job:(await getJob(job.id))!,step:(await listSteps(job.id))[0]!};
}
it('distinguishes stale memory from a scene candidate and routes to the prerequisite chapter',async()=>{
  const c=await fixture();expect(jobAwaitingAction(c.job,c.step)).toBe('memory');
  expect(jobAwaitingLabel(c.job,c.step)).toBe(t.studio.workflow.rebuildAndContinue);
  expect(jobReviewPath(c.job,c.step)).toBe(`/studio/${c.novel.id}/chapters?chapterNo=1`);
  const step={...c.step,input:{awaitingAction:{kind:'memory',chapterId:c.chapters[0]!.id,chapterNo:1}}};
  expect(jobReviewPath(c.job,step)).toBe(`/studio/${c.novel.id}/chapters?chapter=${c.chapters[0]!.id}`);
  expect(jobAwaitingAction({...c.job,error:'必需设定和证据超出模型窗口，请使用更大窗口的模型'},{...c.step,error:null})).toBe('blocker');
});
it('records the actual prerequisite identity before attempting model generation',async()=>{
  const c=await fixture();
  await expect(loadChapterEnv({job:c.job,step:c.step} as StepContext)).rejects.toMatchObject({action:{kind:'memory',chapterId:c.chapters[0]!.id,chapterNo:1}});
});
it('shows repair rather than an empty approval action in both full and compact controls',async()=>{
  const c=await fixture();useJobs.setState({steps:{[c.job.id]:[c.step]}});
  for(const compact of [false,true]){
    const html=renderToStaticMarkup(createElement(MemoryRouter,null,createElement(JobControls,{job:c.job,compact})));
    expect(html).toContain(t.studio.workflow.rebuildAndContinue);expect(html).not.toContain(t.studio.workflow.reviewAction);
  }
  const sceneJob={...c.job,error:'场景计划已生成，请在章节页审阅并采纳'};
  expect(jobAwaitingAction(sceneJob,{...c.step,error:null})).toBe('proposal');
});
it('inserts ordered review, extraction and commit before the original step without certifying memory',async()=>{
  const c=await fixture();const chapterId=await prepareJobMemoryRepair(c.job.id);
  expect(chapterId).toBe(c.chapters[0]!.id);
  const steps=await listSteps(c.job.id);expect(steps).toHaveLength(11);
  expect(steps.map(s=>s.seq)).toEqual(Array.from({length:11},(_,i)=>i));
  for(let i=0;i<3;i++)expect(steps.slice(i*3,i*3+3).map(s=>[s.kind,s.chapterId])).toEqual(['style_check','summarize','commit_chapter'].map(k=>[k,c.chapters[i]!.id]));
  expect(steps[9]).toMatchObject({id:c.step.id,status:'pending',error:null});
  expect((await getJob(c.job.id))!).toMatchObject({status:'queued',error:null,progress:{total:11,currentStepId:null}});
  for(const chapter of c.chapters.slice(0,3))expect((await getChapter(chapter.id))!.memoryStatus).toBe('stale');
  await expect(prepareJobMemoryRepair(c.job.id)).rejects.toThrow('任务状态已变化');
  expect(await listSteps(c.job.id)).toHaveLength(11);
});
it('rolls back sequence and status changes if inserting a prerequisite fails',async()=>{
  const c=await fixture();const before=await listSteps(c.job.id);
  await db.execute("CREATE TRIGGER test_repair_abort BEFORE INSERT ON job_steps WHEN NEW.kind='summarize' BEGIN SELECT RAISE(ABORT,'TEST repair insert blocked'); END");
  await expect(prepareJobMemoryRepair(c.job.id)).rejects.toThrow('TEST repair insert blocked');
  expect(await listSteps(c.job.id)).toEqual(before);expect((await getJob(c.job.id))!.status).toBe('awaiting_review');
});
it('does not acknowledge a memory blocker even when scenes are already confirmed',async()=>{
  const c=await fixture();await saveWritingCard(c.novel.id,{kind:'scene',data:{title:'TEST',volumeId:null,povCharacterId:null,time:'TEST',location:'TEST',characterIds:[],goal:'TEST',obstacle:'TEST',turn:'TEST',outcome:'TEST',targetChars:100,dependencyIds:[],threadIds:[]}},{chapterId:c.chapters[3]!.id,confirmed:true});
  await recoverAcceptedPlanJobs();expect((await getJob(c.job.id))!.status).toBe('awaiting_review');expect((await listSteps(c.job.id))[0]!.status).toBe('failed');
});
