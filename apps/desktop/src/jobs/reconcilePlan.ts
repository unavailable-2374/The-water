import { nanoid } from 'nanoid';
import { getDb, now } from '@/db/db';
import { listChapters } from '@/db/repos/chaptersRepo';
import { getNovel } from '@/db/repos/novelsRepo';
import { listSteps, type Job } from '@/db/repos/jobsRepo';
import { docTypeGuide } from '@/novel/docTypes';
import { planGenerate } from './planner';

/** Reconcile an explicitly resumed whole-book job against an author-adopted chapter plan.
 * Existing steps and prose retain their identities. Subset delegations never expand their scope.
 */
export async function reconcileGenerationPlan(job: Job): Promise<void> {
  if (job.type !== 'generate_novel' || job.params.stage === 'plan' || job.params.only !== null) return;
  const chapters = await listChapters(job.novelId), steps = await listSteps(job.id);
  const active = new Set(chapters.map(chapter => chapter.id));
  const retired = steps.filter(step => step.chapterId && !active.has(step.chapterId) && ['pending','failed'].includes(step.status));
  const known = new Set(steps.map(step => step.chapterId));
  const novel = await getNovel(job.novelId);
  if (!novel) throw new Error('小说不存在');
  const added = planGenerate(chapters.filter(chapter => !known.has(chapter.id)), {fiction:docTypeGuide(novel.requirements.docType).fiction});
  if (!retired.length && !added.length) return;
  const db = getDb(), timestamp = now();
  let seq = Math.max(-1,...steps.map(step => step.seq)) + 1;
  await db.atomic([
    {sql:"UPDATE generation_jobs SET id=id WHERE id=? AND status IN ('paused','failed','awaiting_review')",params:[job.id],expectedRows:1},
    ...retired.map(step => ({sql:"UPDATE job_steps SET status='skipped',finished_at=?,error=NULL WHERE id=? AND status IN ('pending','failed')",params:[timestamp,step.id],expectedRows:1})),
    ...added.map(step => ({sql:"INSERT INTO job_steps(id,job_id,seq,kind,chapter_id,status,input) VALUES (?,?,?,?,?,'pending',?)",params:[nanoid(),job.id,seq++,step.kind,step.chapterId,JSON.stringify(step.input)]})),
    {sql:"UPDATE generation_jobs SET progress=json_set(progress,'$.total',?,'$.done',(SELECT COUNT(*) FROM job_steps WHERE job_id=? AND status IN ('done','skipped'))) WHERE id=?",params:[steps.length+added.length,job.id,job.id],expectedRows:1},
  ]);
}
