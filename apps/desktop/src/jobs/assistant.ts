import { getDb, now, type AtomicWriter } from '@/db/db';
import type { Job, JobStep } from '@/db/repos/jobsRepo';
import { getRun, runGuard } from '@/assistant/repository';
/** Every write of an assistant-owned job joins its durable operation's row journal. */
export function assistantJobWriter(
  job: Job,
  step: JobStep,
  signal: AbortSignal,
): AtomicWriter | undefined {
  const runId = job.params.assistantRunId,
    operationId = job.params.assistantOperationId;
  if (typeof runId !== 'string' || typeof operationId !== 'string') return undefined;
  return async (operations) => {
    signal.throwIfAborted();
    const run = await getRun(runId);
    if (!run || run.novelId !== job.novelId || run.jobId !== job.id)
      throw new Error('Assistant job binding changed');
    const scope = job.params.assistantChapterIds;
    if (step.chapterId && Array.isArray(scope) && !scope.includes(step.chapterId))
      throw new Error('Job chapter exceeds the authorized scope');
    await getDb().atomic([
      runGuard(runId),
      {
        sql: "UPDATE assistant_operations SET id=id WHERE id=? AND run_id=? AND state='waiting_job'",
        params: [operationId, runId],
        expectedRows: 1,
      },
      {
        sql: 'INSERT INTO assistant_mutation_context(singleton,operation_id,novel_id) VALUES (1,?,?)',
        params: [operationId, job.novelId],
      },
      ...operations,
      {
        sql: "UPDATE writing_proposals SET assistant_run_id=?,source_job_id=? WHERE id IN (SELECT row_id FROM assistant_row_changes WHERE operation_id=? AND table_name='writing_proposals' AND before_json IS NULL) AND assistant_run_id IS NULL",
        params: [runId, job.id, operationId],
      },
      // Bind the proposal and checkpoint atomically, so a restart never regenerates it.
      ...(['outline', 'chapter_table', 'extract_style'].includes(step.kind)
        ? [
            {
              sql: "UPDATE job_steps SET input=json_set(input,'$.planProposalId',(SELECT p.id FROM writing_proposals p JOIN assistant_row_changes c ON c.row_id=p.id AND c.table_name='writing_proposals' WHERE c.operation_id=? AND p.assistant_run_id=? AND p.source_job_id=? AND p.state='pending' ORDER BY p.created_at DESC,p.rowid DESC LIMIT 1)) WHERE id=? AND EXISTS(SELECT 1 FROM writing_proposals p WHERE p.assistant_run_id=? AND p.source_job_id=? AND p.state='pending')",
              params: [operationId, runId, job.id, step.id, runId, job.id],
            },
          ]
        : []),
      { sql: 'DELETE FROM assistant_mutation_context WHERE singleton=1' },
      {
        sql: 'UPDATE assistant_operations SET after_revision=(SELECT revision FROM assistant_revisions WHERE novel_id=?),updated_at=? WHERE id=?',
        params: [job.novelId, now(), operationId],
      },
    ]);
  };
}
