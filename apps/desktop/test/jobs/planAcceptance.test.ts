/** TEST fixtures only: no real model calls or user data. */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { createNovel } from '@/db/repos/novelsRepo';
import { defaultRequirements } from '@/novel/types';
import { buildStorylineDoc } from '@/db/repos/storylineRepo';
import { acceptDocumentPlan, proposeDocumentPlan } from '@/db/repos/planProposalsRepo';
import { recoverAcceptedPlanJobs } from '@/db/repos/planJobCompletion';
import { createJob, getJob, listSteps, setJobStatus, stepFailed, updateProgress, isBlockingJob } from '@/db/repos/jobsRepo';
import { discardProposal, proposeCard, acceptPlanProposal, listPlanProposals, listWritingCards, saveWritingCard } from '@/db/repos/writingRepo';
import { upsertChapterPlan } from '@/db/repos/chaptersRepo';

let db: ReturnType<typeof useTestDb>;
beforeEach(() => { db=useTestDb(); });
afterEach(() => { db.raw.close(); });
async function checkpoint(more=false) {
  const novel=await createNovel({title:'TEST',premise:'TEST',targetChars:1000,requirements:defaultRequirements()});
  const doc=await buildStorylineDoc(novel.id,novel.premise,[]);
  const proposal=await proposeDocumentPlan(novel.id,doc,'TEST proposal');
  const job=await createJob({novelId:novel.id,type:'generate_novel',params:{stage:'plan'},providerId:null,steps:[{kind:'outline',input:{planProposalId:proposal}},...(more?[{kind:'chapter_table' as const}]:[])]});
  const step=(await listSteps(job.id))[0]!;
  await stepFailed(step.id,'TEST waiting for adoption');
  await setJobStatus(job.id,'awaiting_review',{error:'TEST waiting for adoption'});
  await updateProgress(job.id,{currentStepId:step.id,message:'TEST waiting for adoption'});
  return {novel,proposal,job,step};
}
it('completes an outline-only job atomically with adoption and clears stale errors', async()=>{
  const c=await checkpoint();await acceptDocumentPlan(c.novel.id,c.proposal);
  const job=(await getJob(c.job.id))!;expect(job.status).toBe('completed');expect(job.error).toBeNull();expect(job.progress.done).toBe(1);expect(job.progress.message).toBe('');
  const step=(await listSteps(job.id))[0]!;expect(step.status).toBe('done');expect(step.outputRef).toBe(c.proposal);expect(step.error).toBeNull();
});
it('queues remaining planning work without regenerating the approved outline', async()=>{
  const c=await checkpoint(true);await acceptDocumentPlan(c.novel.id,c.proposal);
  expect((await getJob(c.job.id))!.status).toBe('queued');
  expect((await listSteps(c.job.id)).map(s=>s.status)).toEqual(['done','pending']);
});
it('recovers legacy accepted checkpoints but leaves pending proposals and cancelled jobs alone', async()=>{
  const accepted=await checkpoint(),pending=await checkpoint(),cancelled=await checkpoint();
  await db.execute("UPDATE writing_proposals SET state='accepted' WHERE id IN (?,?)",[accepted.proposal,cancelled.proposal]);
  await setJobStatus(cancelled.job.id,'cancelled');
  await recoverAcceptedPlanJobs();
  expect((await getJob(accepted.job.id))!.status).toBe('completed');
  expect((await getJob(pending.job.id))!.status).toBe('awaiting_review');
  expect((await getJob(cancelled.job.id))!.status).toBe('cancelled');
});
it('does not acknowledge a checkpoint when adoption fails its base-plan guard', async()=>{
  const c=await checkpoint();await db.execute('UPDATE novels SET meta=? WHERE id=?',[JSON.stringify({themes:['TEST changed']}),c.novel.id]);
  await expect(acceptDocumentPlan(c.novel.id,c.proposal)).rejects.toThrow('基础计划已改变');
  expect((await getJob(c.job.id))!.status).toBe('awaiting_review');
  expect((await listSteps(c.job.id))[0]!.status).toBe('failed');
});
it('reconciles approval that arrives before the runner records awaiting review', async()=>{
  const c=await checkpoint();await setJobStatus(c.job.id,'running');
  await acceptDocumentPlan(c.novel.id,c.proposal);
  expect((await getJob(c.job.id))!.status).toBe('running');
  await setJobStatus(c.job.id,'awaiting_review',{error:'TEST late review message'});
  await recoverAcceptedPlanJobs(c.proposal);
  expect((await getJob(c.job.id))!.status).toBe('completed');
});
it('discarding the requested outline releases its job and preserves the confirmed plan', async()=>{
  const c=await checkpoint();const before=await buildStorylineDoc(c.novel.id,c.novel.premise,[]);
  await discardProposal(c.proposal);
  const job=(await getJob(c.job.id))!;expect(job.status).toBe('cancelled');expect(isBlockingJob(job.status)).toBe(false);expect(job.error).toBeNull();
  expect((await listSteps(job.id))[0]).toMatchObject({status:'skipped',error:null});
  expect(await buildStorylineDoc(c.novel.id,c.novel.premise,[])).toEqual(before);
});
it('approving extracted materials completes their checkpoint too', async()=>{
  const c=await checkpoint();await db.execute("UPDATE job_steps SET kind='extract_style' WHERE id=?",[c.step.id]);
  await acceptDocumentPlan(c.novel.id,c.proposal);expect((await getJob(c.job.id))!.status).toBe('completed');
});
it('recovers a rejection that arrived before awaiting review was recorded', async()=>{
  const c=await checkpoint();await setJobStatus(c.job.id,'running');await discardProposal(c.proposal);
  await setJobStatus(c.job.id,'awaiting_review');await recoverAcceptedPlanJobs(c.proposal);
  expect((await getJob(c.job.id))!.status).toBe('cancelled');
});
it('rolls approval back if the linked checkpoint cannot commit', async()=>{
  const c=await checkpoint();await db.execute("CREATE TRIGGER test_checkpoint_abort BEFORE UPDATE OF status ON generation_jobs WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'TEST checkpoint interrupted'); END");
  await expect(acceptDocumentPlan(c.novel.id,c.proposal)).rejects.toThrow('TEST checkpoint interrupted');
  expect(db.raw.prepare('SELECT state FROM writing_proposals WHERE id=?').get(c.proposal)).toMatchObject({state:'pending'});
  expect((await listSteps(c.job.id))[0]!.status).toBe('failed');
});

const scene = {title:'TEST scene',volumeId:null,povCharacterId:null,time:'TEST morning',location:'TEST room',characterIds:[],goal:'TEST goal',obstacle:'TEST obstacle',turn:'TEST choice',outcome:'TEST result',targetChars:500,dependencyIds:[],threadIds:[]};
async function sceneCheckpoint(more=false) {
  const novel=await createNovel({title:'TEST scenes',premise:'TEST',targetChars:1000,requirements:defaultRequirements()});
  const chapter=await upsertChapterPlan(novel.id,{chapterNo:1,title:'TEST chapter',targetChars:1000});
  const future=await upsertChapterPlan(novel.id,{chapterNo:2,title:'TEST future',targetChars:1000});
  const ids=[await proposeCard(novel.id,{kind:'scene',data:scene},chapter.id),await proposeCard(novel.id,{kind:'scene',data:{...scene,title:'TEST second scene'}},chapter.id)];
  const futureId=await proposeCard(novel.id,{kind:'scene',data:scene},future.id);
  const job=await createJob({novelId:novel.id,type:'generate_novel',params:{},providerId:null,steps:[{kind:'scene_plan',chapterId:chapter.id},...(more?[{kind:'write_scenes' as const,chapterId:chapter.id}]:[])]});
  const step=(await listSteps(job.id))[0]!;await stepFailed(step.id,'TEST scene review');await setJobStatus(job.id,'awaiting_review');await updateProgress(job.id,{currentStepId:step.id});
  return {novel,chapter,ids,futureId,job};
}
it('continues after all current-chapter scenes are approved, without approving future chapters',async()=>{
  const c=await sceneCheckpoint(true);await acceptPlanProposal(c.novel.id,c.ids[0]!);
  expect((await getJob(c.job.id))!.status).toBe('awaiting_review');
  await acceptPlanProposal(c.novel.id,c.ids[1]!);
  expect((await getJob(c.job.id))!.status).toBe('queued');
  expect((await listSteps(c.job.id)).map(s=>s.status)).toEqual(['done','pending']);
  expect((await listPlanProposals(c.novel.id)).map(p=>p.id)).toEqual([c.futureId]);
});
it('rejecting every scene cancels the blocked task without fabricating confirmed cards',async()=>{
  const c=await sceneCheckpoint();for(const id of c.ids)await discardProposal(id);
  expect((await getJob(c.job.id))!.status).toBe('cancelled');
  expect(await listWritingCards(c.novel.id,{kind:'scene',chapterId:c.chapter.id})).toHaveLength(0);
});
it('retains the approved scene when the remaining suggestion is discarded',async()=>{
  const c=await sceneCheckpoint();await acceptPlanProposal(c.novel.id,c.ids[0]!);await discardProposal(c.ids[1]!);
  expect((await getJob(c.job.id))!.status).toBe('completed');
  expect(await listWritingCards(c.novel.id,{kind:'scene',chapterId:c.chapter.id,confirmed:true})).toHaveLength(1);
});
it('acknowledges manual scene confirmation only when every current-chapter card is confirmed',async()=>{
  const c=await sceneCheckpoint();
  for(const id of c.ids)await db.execute("UPDATE writing_proposals SET state='discarded' WHERE id=?",[id]);
  const first=await saveWritingCard(c.novel.id,{kind:'scene',data:scene},{chapterId:c.chapter.id});
  const second=await saveWritingCard(c.novel.id,{kind:'scene',data:scene},{chapterId:c.chapter.id});
  await saveWritingCard(c.novel.id,{kind:'scene',data:scene},{id:first,expectedRevision:1,confirmed:true});
  expect((await getJob(c.job.id))!.status).toBe('awaiting_review');
  await saveWritingCard(c.novel.id,{kind:'scene',data:scene},{id:second,expectedRevision:1,confirmed:true});
  expect((await getJob(c.job.id))!.status).toBe('completed');
  expect((await listPlanProposals(c.novel.id)).map(p=>p.id)).toEqual([c.futureId]);
});

it('TEST adopts generated scenes in their planned order even when reviewed in reverse',async()=>{
  const c=await sceneCheckpoint();
  for(let i=0;i<c.ids.length;i++){const row=db.raw.prepare('SELECT json FROM writing_proposals WHERE id=?').get(c.ids[i]!) as {json:string};await db.execute('UPDATE writing_proposals SET json=? WHERE id=?',[JSON.stringify({...JSON.parse(row.json),order:i,card:{kind:'scene',data:{...scene,title:`TEST scene ${i}`}}}),c.ids[i]!]);}
  for(const id of [...c.ids].reverse())await acceptPlanProposal(c.novel.id,id);
  expect((await listWritingCards(c.novel.id,{kind:'scene',chapterId:c.chapter.id,confirmed:true})).filter(c=>c.kind==='scene').map(c=>c.data.title)).toEqual(['TEST scene 0','TEST scene 1']);
});
