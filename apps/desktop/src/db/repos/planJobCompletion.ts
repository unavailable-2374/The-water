import { getDb, now, type AtomicOperation } from '../db';
import { listJobs, listSteps } from './jobsRepo';
import { emitJobEvent } from '@/jobs/events';

/** Commit the approved checkpoint, never rerun its model request. */
export function acceptedPlanJobOperations(time: number, proposalId?: string, novelId?: string): AtomicOperation[] {
  return [
    {
      sql: `UPDATE job_steps SET status='done', error=NULL, partial_text=NULL,
        output_ref=json_extract(input,'$.planProposalId'), finished_at=?
        WHERE kind IN ('outline','chapter_table','extract_style') AND status='failed'
          AND (? IS NULL OR json_extract(input,'$.planProposalId')=?)
          AND (? IS NULL OR job_id IN (SELECT id FROM generation_jobs WHERE novel_id=?))
          AND EXISTS (SELECT 1 FROM generation_jobs j JOIN writing_proposals p
            ON p.id=json_extract(job_steps.input,'$.planProposalId') AND p.novel_id=j.novel_id
            WHERE j.id=job_steps.job_id AND j.status='awaiting_review' AND p.state='accepted'
              AND json_extract(j.progress,'$.currentStepId')=job_steps.id)`,
      params: [time, proposalId ?? null, proposalId ?? null, novelId ?? null, novelId ?? null],
    },
    {
      sql: `UPDATE job_steps SET status='done', error=NULL, partial_text=NULL, finished_at=?,
        output_ref=(SELECT id FROM writing_cards c WHERE c.chapter_id=job_steps.chapter_id AND c.kind='scene' AND c.confirmed=1 ORDER BY sort_order LIMIT 1)
        WHERE kind='scene_plan' AND status='failed'
          AND COALESCE(json_extract(input,'$.awaitingAction.kind'),'')<>'memory'
          AND COALESCE(error,'') NOT LIKE '第 % 章记忆尚未重建%'
          AND (? IS NULL OR job_id IN (SELECT id FROM generation_jobs WHERE novel_id=?))
          AND EXISTS (SELECT 1 FROM generation_jobs j WHERE j.id=job_steps.job_id AND j.status='awaiting_review' AND json_extract(j.progress,'$.currentStepId')=job_steps.id)
          AND EXISTS (SELECT 1 FROM writing_cards c WHERE c.chapter_id=job_steps.chapter_id AND c.kind='scene' AND c.confirmed=1)
          AND NOT EXISTS (SELECT 1 FROM writing_cards c WHERE c.chapter_id=job_steps.chapter_id AND c.kind='scene' AND c.confirmed=0)
          AND NOT EXISTS (SELECT 1 FROM writing_proposals p WHERE p.chapter_id=job_steps.chapter_id AND p.kind='plan' AND p.state='pending')
          AND (? IS NULL OR EXISTS (SELECT 1 FROM writing_proposals p WHERE p.chapter_id=job_steps.chapter_id AND p.id=?))`,
      params: [time, novelId ?? null, novelId ?? null, proposalId ?? null, proposalId ?? null],
    },
    {
      sql: `UPDATE generation_jobs SET
        status=CASE WHEN EXISTS (SELECT 1 FROM job_steps s WHERE s.job_id=generation_jobs.id AND s.status='failed') THEN 'failed'
          WHEN EXISTS (SELECT 1 FROM job_steps s WHERE s.job_id=generation_jobs.id AND s.status='pending') THEN 'queued' ELSE 'completed' END,
        error=(SELECT s.error FROM job_steps s WHERE s.job_id=generation_jobs.id AND s.status='failed' ORDER BY seq LIMIT 1),
        progress=json_set(progress,'$.done',(SELECT COUNT(*) FROM job_steps s WHERE s.job_id=generation_jobs.id AND s.status IN ('done','skipped')),
          '$.currentStepId',NULL,'$.message',''), updated_at=?,
        finished_at=CASE WHEN EXISTS (SELECT 1 FROM job_steps s WHERE s.job_id=generation_jobs.id AND s.status='pending') THEN NULL ELSE ? END
        WHERE status='awaiting_review' AND (? IS NULL OR novel_id=?) AND (EXISTS (SELECT 1 FROM job_steps s JOIN writing_proposals p ON p.id=s.output_ref
          WHERE s.id=json_extract(generation_jobs.progress,'$.currentStepId') AND s.job_id=generation_jobs.id
            AND s.kind IN ('outline','chapter_table','extract_style') AND s.status='done' AND p.state='accepted' AND p.novel_id=generation_jobs.novel_id
            AND (? IS NULL OR p.id=?)) OR EXISTS (SELECT 1 FROM job_steps s WHERE s.id=json_extract(generation_jobs.progress,'$.currentStepId')
              AND s.job_id=generation_jobs.id AND s.kind='scene_plan' AND s.status='done'
              AND (? IS NULL OR EXISTS (SELECT 1 FROM writing_proposals p WHERE p.chapter_id=s.chapter_id AND p.id=?))))`,
      params: [time, time, novelId ?? null, novelId ?? null, proposalId ?? null, proposalId ?? null, proposalId ?? null, proposalId ?? null],
    },
  ];
}

/** Rejection ends only the task waiting for that proposal; it preserves confirmed work. */
export function discardedPlanJobOperations(time: number, proposalId?: string): AtomicOperation[] {
  return [{
    sql: `UPDATE generation_jobs SET status='cancelled',error=NULL,finished_at=?,updated_at=?,
      progress=json_set(progress,'$.currentStepId',NULL,'$.message','')
      WHERE status='awaiting_review' AND EXISTS (SELECT 1 FROM job_steps s JOIN writing_proposals p ON p.state='discarded' AND p.novel_id=generation_jobs.novel_id
        WHERE s.id=json_extract(generation_jobs.progress,'$.currentStepId') AND s.job_id=generation_jobs.id
          AND (? IS NULL OR p.id=?)
          AND ((s.kind IN ('outline','chapter_table','extract_style') AND json_extract(s.input,'$.planProposalId')=p.id)
            OR (s.kind='scene_plan' AND s.chapter_id=p.chapter_id
              AND NOT EXISTS (SELECT 1 FROM writing_proposals q WHERE q.chapter_id=s.chapter_id AND q.kind='plan' AND q.state='pending')
              AND NOT EXISTS (SELECT 1 FROM writing_cards c WHERE c.chapter_id=s.chapter_id AND c.kind='scene'))))`,
    params: [time,time,proposalId ?? null,proposalId ?? null],
  }, {
    sql: `UPDATE job_steps SET status='skipped',error=NULL,partial_text=NULL,finished_at=?
      WHERE status='failed' AND EXISTS (SELECT 1 FROM generation_jobs j JOIN writing_proposals p ON p.novel_id=j.novel_id AND p.state='discarded'
        WHERE j.id=job_steps.job_id AND j.status='cancelled' AND j.updated_at=? AND (? IS NULL OR p.id=?)
          AND ((job_steps.kind IN ('outline','chapter_table','extract_style') AND json_extract(job_steps.input,'$.planProposalId')=p.id)
            OR (job_steps.kind='scene_plan' AND job_steps.chapter_id=p.chapter_id)))`,
    params:[time,time,proposalId ?? null,proposalId ?? null],
  }];
}

export async function publishPlanJobCompletion(novelId: string): Promise<void> {
  for (const job of await listJobs({ novelId })) {
    emitJobEvent({ type: 'job:updated', job });
    for (const step of await listSteps(job.id)) emitJobEvent({ type: 'step:updated', step });
  }
  emitJobEvent({ type: 'plan:resolved', novelId });
}

/** Recover approvals committed by older versions, or before a process exited. */
export async function recoverAcceptedPlanJobs(proposalId?: string): Promise<void> {
  const time = now();
  await getDb().atomic([...discardedPlanJobOperations(time, proposalId), ...acceptedPlanJobOperations(time, proposalId)]);
}
