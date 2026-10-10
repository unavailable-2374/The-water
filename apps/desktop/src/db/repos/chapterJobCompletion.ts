import { type AtomicOperation } from '../db';

/** Author approval and the waiting commit checkpoint share the manuscript transaction. */
export function acceptedChapterJobOperations(chapterId:string,commitId:string,time:number):AtomicOperation[] {
  return [{
    sql:`UPDATE job_steps SET status='done',output_ref=?,error=NULL,partial_text=NULL,finished_at=?
      WHERE chapter_id=? AND kind='commit_chapter' AND status='failed'
        AND EXISTS (SELECT 1 FROM generation_jobs j WHERE j.id=job_steps.job_id
          AND j.status='awaiting_review' AND json_extract(j.progress,'$.currentStepId')=job_steps.id)
        AND EXISTS (SELECT 1 FROM chapter_commits cc JOIN chapters c ON c.id=cc.chapter_id
          WHERE cc.id=? AND c.id=job_steps.chapter_id AND cc.version_id=c.current_version_id
          AND c.committed_version_id=cc.version_id AND c.memory_status='valid')`,
    params:[commitId,time,chapterId,commitId],
  },{
    sql:`UPDATE generation_jobs SET
      status=CASE WHEN EXISTS (SELECT 1 FROM job_steps s WHERE s.job_id=generation_jobs.id AND s.status='failed') THEN 'failed'
        WHEN EXISTS (SELECT 1 FROM job_steps s WHERE s.job_id=generation_jobs.id AND s.status='pending') THEN 'queued' ELSE 'completed' END,
      error=(SELECT s.error FROM job_steps s WHERE s.job_id=generation_jobs.id AND s.status='failed' ORDER BY seq LIMIT 1),
      progress=json_set(progress,'$.done',(SELECT COUNT(*) FROM job_steps s WHERE s.job_id=generation_jobs.id AND s.status IN ('done','skipped')),'$.currentStepId',NULL,'$.message',''),
      updated_at=?,finished_at=CASE WHEN EXISTS (SELECT 1 FROM job_steps s WHERE s.job_id=generation_jobs.id AND s.status='pending') THEN NULL ELSE ? END
      WHERE status='awaiting_review' AND EXISTS (SELECT 1 FROM job_steps s
        WHERE s.id=json_extract(generation_jobs.progress,'$.currentStepId') AND s.job_id=generation_jobs.id
          AND s.chapter_id=? AND s.kind='commit_chapter' AND s.status='done' AND s.output_ref=?)`,
    params:[time,time,chapterId,commitId],
  }];
}
