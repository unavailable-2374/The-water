import { writeAtomic, type AtomicWriter } from '../db';
import { nanoid } from 'nanoid';
import { now, type AtomicOperation } from '../db';
import { getChapter, listChapters } from './chaptersRepo';
import { getJob, listSteps } from './jobsRepo';
import { planStyleCheck } from '@/jobs/planner';
import { jobAwaitingAction } from '@/jobs/presentation';
import { publishPlanJobCompletion } from './planJobCompletion';

/** Queue prerequisite review in the original task; never certify stale memory locally. */
export async function prepareJobMemoryRepair(jobId:string,commit:AtomicWriter=writeAtomic):Promise<string> {
  const job=await getJob(jobId);
  const steps=await listSteps(jobId);
  const current=steps.find(s=>s.id===job?.progress.currentStepId);
  if (!job || job.status!=='awaiting_review' || !current?.chapterId || current.status!=='failed' || jobAwaitingAction(job,current)!=='memory') throw new Error('任务状态已变化，请刷新后重试');
  const chapter=await getChapter(current.chapterId);
  if (!chapter || chapter.novelId!==job.novelId) throw new Error('任务章节不存在');
  const stale=(await listChapters(job.novelId)).filter(c=>c.chapterNo<chapter.chapterNo && c.committedVersionId && c.memoryStatus!=='valid');
  if (!stale.length) throw new Error('前文记忆已重建，请继续当前任务');
  if (stale.some(c=>!c.currentVersionId)) throw new Error('前文章节缺少工作稿，无法重新审查');
  const repair=stale.flatMap(planStyleCheck);
  const tail=steps.filter(s=>s.seq>=current.seq);
  const time=now();
  const operations:AtomicOperation[]=[{
    sql:"UPDATE generation_jobs SET status='queued',error=NULL,finished_at=NULL,updated_at=?,progress=json_set(progress,'$.total',?,'$.currentStepId',NULL,'$.message','') WHERE id=? AND status='awaiting_review' AND json_extract(progress,'$.currentStepId')=?",
    params:[time,steps.length+repair.length,jobId,current.id],expectedRows:1,
  },...tail.map(s=>({sql:'UPDATE job_steps SET seq=? WHERE id=? AND seq=?',params:[-s.seq-1,s.id,s.seq],expectedRows:1})),
  ...tail.map(s=>({sql:'UPDATE job_steps SET seq=? WHERE id=?',params:[s.seq+repair.length,s.id],expectedRows:1})),
  ...repair.map((s,index)=>({sql:"INSERT INTO job_steps(id,job_id,seq,kind,chapter_id,status,input) VALUES (?,?,?,?,?,'pending',?)",params:[nanoid(),jobId,current.seq+index,s.kind,s.chapterId,JSON.stringify({...s.input,memoryRepair:true})]})),{
    sql:"UPDATE job_steps SET status='pending',error=NULL,finished_at=NULL,input=? WHERE id=? AND status='failed'",params:[JSON.stringify({...current.input,awaitingAction:null,dependencyHash:null,candidateVersionId:null,candidateHash:null}),current.id],expectedRows:1,
  }];
  await commit(operations);
  await publishPlanJobCompletion(job.novelId);
  return stale[0]!.id;
}
