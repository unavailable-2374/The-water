import { writeAtomic, writeStatement, type AtomicWriter } from '../db';
import { nanoid } from 'nanoid';
import { getDb, now, selectOne } from '../db';
import { num, parseJsonLoose } from '../mappers';

export type JobType = 'generate_novel' | 'regenerate_chapter' | 'rewrite' | 'extract_style' | 'style_check';
export type JobStatus = 'queued' | 'running' | 'pausing' | 'paused' | 'cancelling' | 'cancelled' | 'failed' | 'completed' | 'awaiting_review';

/**
 * 「这本小说已有任务占着，不能再起新任务」的判定 —— 服务层与界面必须用同一份，
 * 否则会出现按钮灰着但服务层其实肯收（failed 就是这样），用户只能干瞪眼。
 * 注意 failed / cancelling 不在其中：失败的任务不该锁死整本书的手工操作。
 */
export const BLOCKING_JOB_STATUSES = ['queued', 'running', 'pausing', 'paused', 'awaiting_review'] as const satisfies readonly JobStatus[];

export function isBlockingJob(status: JobStatus): boolean {
  return (BLOCKING_JOB_STATUSES as readonly JobStatus[]).includes(status);
}
export type StepKind = 'outline' | 'chapter_table' | 'write_chapter' | 'adjust_length' | 'summarize' | 'rewrite_chapter' | 'name_replace' | 'style_check' | 'extract_style' | 'scene_plan' | 'write_scenes' | 'commit_chapter';
/**
 * 流式输出就是「章节正文」的步骤。只有这些步骤的 delta 该显示在章节编辑器里。
 * 总结 / 风格审校 / 设定校对 / 大纲 / 章节表 / 拆书输出的是 JSON，
 * 曾经也往同一条通道推，结果读者在正文区看到一坨 {"summary":...}。
 */
export const PROSE_STEP_KINDS = ['write_scenes', 'write_chapter', 'rewrite_chapter', 'adjust_length', 'style_check'] as const satisfies readonly StepKind[];

export function isProseStep(kind: StepKind): boolean {
  return (PROSE_STEP_KINDS as readonly StepKind[]).includes(kind);
}

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface JobProgress { done: number; total: number; currentStepId: string | null; charsSoFar: number; message: string }
export interface Job {
  id: string; novelId: string; type: JobType; status: JobStatus; params: Record<string, unknown>; providerId: string | null;
  progress: JobProgress; error: string | null; interrupted: boolean; createdAt: number; startedAt: number | null; updatedAt: number; finishedAt: number | null;
}
export interface JobStep {
  id: string; jobId: string; seq: number; kind: StepKind; chapterId: string | null; status: StepStatus; attempts: number;
  input: Record<string, unknown>; outputRef: string | null; partialText: string | null; error: string | null; startedAt: number | null; finishedAt: number | null;
}
interface RawJ { id: string; novel_id: string; type: string; status: string; params: string; provider_id: string | null; progress: string; error: string | null; interrupted: number; created_at: number; started_at: number | null; updated_at: number; finished_at: number | null }
interface RawS { id: string; job_id: string; seq: number; kind: string; chapter_id: string | null; status: string; attempts: number; input: string; output_ref: string | null; partial_text: string | null; error: string | null; started_at: number | null; finished_at: number | null }
const emptyProgress = (): JobProgress => ({ done: 0, total: 0, currentStepId: null, charsSoFar: 0, message: '' });
const mapJ = (r: RawJ): Job => ({
  id: r.id, novelId: r.novel_id, type: r.type as JobType, status: r.status as JobStatus, params: parseJsonLoose(r.params, {}), providerId: r.provider_id,
  progress: { ...emptyProgress(), ...parseJsonLoose<Partial<JobProgress>>(r.progress, {}) }, error: r.error, interrupted: r.interrupted === 1,
  createdAt: r.created_at, startedAt: r.started_at, updatedAt: r.updated_at, finishedAt: r.finished_at,
});
const mapS = (r: RawS): JobStep => ({
  id: r.id, jobId: r.job_id, seq: r.seq, kind: r.kind as StepKind, chapterId: r.chapter_id, status: r.status as StepStatus, attempts: num(r.attempts),
  input: parseJsonLoose(r.input, {}), outputRef: r.output_ref, partialText: r.partial_text, error: r.error, startedAt: r.started_at, finishedAt: r.finished_at,
});

export async function createJob(input: { novelId: string; type: JobType; params: Record<string, unknown>; providerId: string | null; commit?: AtomicWriter; id?: string; steps: Array<{ kind: StepKind; chapterId?: string | null; input?: Record<string, unknown> }> }): Promise<Job> {
  const id = input.id ?? nanoid();
  const t = now();
  await (input.commit ?? writeAtomic)([
    {sql:'INSERT INTO generation_jobs(id, novel_id, type, status, params, provider_id, progress, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',params:[id,input.novelId,input.type,'queued',JSON.stringify({...input.params,pipelineVersion:2}),input.providerId,JSON.stringify({...emptyProgress(),total:input.steps.length}),t,t]},
    ...input.steps.map((step,seq)=>({sql:'INSERT INTO job_steps(id,job_id,seq,kind,chapter_id,status,input) VALUES (?,?,?,?,?,?,?)',params:[nanoid(),id,seq,step.kind,step.chapterId ?? null,'pending',JSON.stringify(step.input ?? {})]})),
  ]);
  return (await getJob(id))!;
}
export async function appendSteps(jobId: string, steps: Array<{ kind: StepKind; chapterId?: string | null; input?: Record<string, unknown> }>): Promise<void> {
  const db = getDb();
  const last = await selectOne<{ m: number | null }>('SELECT MAX(seq) AS m FROM job_steps WHERE job_id = ?', [jobId]);
  let seq = (last?.m ?? -1) + 1;
  for (const s of steps) await db.execute('INSERT INTO job_steps(id, job_id, seq, kind, chapter_id, status, input) VALUES (?,?,?,?,?,?,?)', [nanoid(), jobId, seq++, s.kind, s.chapterId ?? null, 'pending', JSON.stringify(s.input ?? {})]);
  const total = await selectOne<{ c: number }>('SELECT COUNT(*) AS c FROM job_steps WHERE job_id = ?', [jobId]);
  const job = await getJob(jobId);
  if (job) await updateProgress(jobId, { total: total?.c ?? job.progress.total });
}
export async function getJob(id: string): Promise<Job | null> {
  const r = await selectOne<RawJ>('SELECT * FROM generation_jobs WHERE id = ?', [id]);
  return r ? mapJ(r) : null;
}
export async function listJobs(filter: { novelId?: string; statuses?: JobStatus[] } = {}): Promise<Job[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.novelId) { where.push('novel_id = ?'); params.push(filter.novelId); }
  if (filter.statuses?.length) { where.push(`status IN (${filter.statuses.map(() => '?').join(',')})`); params.push(...filter.statuses); }
  return (await getDb().select<RawJ>(`SELECT * FROM generation_jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at ASC`, params)).map(mapJ);
}
export async function setJobStatus(id: string, status: JobStatus, extra: { error?: string | null; interrupted?: boolean } = {}, commit:AtomicWriter=writeAtomic): Promise<void> {
  const t = now();
  const finished = ['completed', 'failed', 'cancelled'].includes(status) ? t : null;
  const started = status === 'running' ? t : null;
  await writeStatement(commit,
    `UPDATE generation_jobs SET status = ?, error = CASE WHEN ? THEN ? ELSE error END, interrupted = COALESCE(?, interrupted), updated_at = ?,
       started_at = COALESCE(started_at, ?), finished_at = COALESCE(?, CASE WHEN ? IN ('completed','failed','cancelled') THEN finished_at ELSE NULL END) WHERE id = ?`,
    [status, extra.error !== undefined ? 1 : 0, extra.error ?? null, extra.interrupted === undefined ? null : extra.interrupted ? 1 : 0, t, started, finished, status, id],
  );
}
export async function updateProgress(id: string, patch: Partial<JobProgress>): Promise<void> {
  const job = await getJob(id);
  if (!job) return;
  await getDb().execute('UPDATE generation_jobs SET progress = ?, updated_at = ? WHERE id = ?', [JSON.stringify({ ...job.progress, ...patch }), now(), id]);
}
/** On boot: any job left running/pausing/cancelling is marked paused+interrupted; running steps go back to pending. */
export async function markInterrupted(): Promise<Job[]> {
  const db = getDb();
  const jobs = await listJobs({ statuses: ['running', 'pausing', 'cancelling'] });
  for (const j of jobs) {
    await db.execute("UPDATE job_steps SET status = 'pending' WHERE job_id = ? AND status = 'running'", [j.id]);
    await db.execute("UPDATE generation_jobs SET status = 'paused', interrupted = 1, updated_at = ? WHERE id = ?", [now(), j.id]);
  }
  return listJobs({ statuses: ['paused'] });
}
export async function deleteJob(id: string): Promise<void> {
  await getDb().execute('DELETE FROM generation_jobs WHERE id = ?', [id]);
}

export async function listSteps(jobId: string): Promise<JobStep[]> {
  return (await getDb().select<RawS>('SELECT * FROM job_steps WHERE job_id = ? ORDER BY seq', [jobId])).map(mapS);
}
export async function getStep(id: string): Promise<JobStep | null> {
  const r = await selectOne<RawS>('SELECT * FROM job_steps WHERE id = ?', [id]);
  return r ? mapS(r) : null;
}
export async function nextPendingStep(jobId: string): Promise<JobStep | null> {
  const r = await selectOne<RawS>("SELECT * FROM job_steps WHERE job_id = ? AND status = 'pending' ORDER BY seq LIMIT 1", [jobId]);
  return r ? mapS(r) : null;
}
export async function stepStarted(id: string): Promise<void> {
  await getDb().execute("UPDATE job_steps SET status = 'running', attempts = attempts + 1, started_at = ?, error = NULL WHERE id = ?", [now(), id]);
}
export async function stepDone(id: string, outputRef: string | null): Promise<void> {
  await getDb().execute("UPDATE job_steps SET status = 'done', output_ref = ?, partial_text = NULL, finished_at = ? WHERE id = ?", [outputRef, now(), id]);
}
export async function stepFailed(id: string, error: string): Promise<void> {
  await getDb().execute("UPDATE job_steps SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", [error, now(), id]);
}
export async function stepReset(id: string): Promise<void> {
  await getDb().execute("UPDATE job_steps SET status = 'pending', finished_at = NULL WHERE id = ?", [id]);
}
export function isRequiredStep(kind: StepKind): boolean { return ['style_check','summarize','commit_chapter','scene_plan'].includes(kind); }
export async function stepSkipped(id: string): Promise<void> {
  const step = await getStep(id);
  if (step && isRequiredStep(step.kind)) throw new Error('必需审查、规划和提交步骤不能跳过');
  await getDb().execute("UPDATE job_steps SET status = 'skipped', finished_at = ? WHERE id = ?", [now(), id]);
}
export async function stepPartial(id: string, text: string): Promise<void> {
  await getDb().execute('UPDATE job_steps SET partial_text = ? WHERE id = ?', [text, id]);
}
export async function setStepInput(id: string, input: Record<string, unknown>): Promise<void> {
  await getDb().execute('UPDATE job_steps SET input = ? WHERE id = ?', [JSON.stringify(input), id]);
}
export async function stepCounts(jobId: string): Promise<{ done: number; total: number }> {
  const r = await selectOne<{ done: number; total: number }>("SELECT SUM(CASE WHEN status IN ('done','skipped') THEN 1 ELSE 0 END) AS done, COUNT(*) AS total FROM job_steps WHERE job_id = ?", [jobId]);
  return { done: r?.done ?? 0, total: r?.total ?? 0 };
}

/** Upgrade unfinished V8 jobs without discarding prose, partial output or step identities. */
export async function upgradeLegacyJobs():Promise<void> {
  for(const job of await listJobs({statuses:['queued','running','pausing','paused','failed','awaiting_review']})) {
    if(job.params.pipelineVersion===2) continue;
    const steps=await listSteps(job.id);
    const ordered:Array<{existing?:JobStep;kind:StepKind;chapterId:string|null;input:Record<string,unknown>}>=[];
    for(const [index,step] of steps.entries()) {
      ordered.push({existing:step,kind:step.kind,chapterId:step.chapterId,input:step.input});
      if(!step.chapterId || steps.slice(index+1).some(s=>s.chapterId===step.chapterId)) continue;
      const same=steps.filter(s=>s.chapterId===step.chapterId);
      if(!same.some(s=>['write_chapter','write_scenes','rewrite_chapter','adjust_length','name_replace','style_check','summarize'].includes(s.kind)) || same.some(s=>s.kind==='commit_chapter')) continue;
      for(const kind of ['style_check','summarize','commit_chapter'] as const) ordered.push({kind,chapterId:step.chapterId,input:{chapterNo:step.input.chapterNo,legacyRebuild:true}});
    }
    await getDb().atomic([
      ...steps.map(s=>({sql:"UPDATE job_steps SET seq=?,status=CASE WHEN status='running' THEN 'pending' ELSE status END WHERE id=?",params:[-s.seq-1,s.id]})),
      ...ordered.map((s,seq)=>s.existing ? {sql:'UPDATE job_steps SET seq=? WHERE id=?',params:[seq,s.existing.id]} : {sql:"INSERT INTO job_steps(id,job_id,seq,kind,chapter_id,status,input) VALUES (?,?,?,?,?,'pending',?)",params:[nanoid(),job.id,seq,s.kind,s.chapterId,JSON.stringify(s.input)]}),
      {sql:"UPDATE generation_jobs SET params=?,status='awaiting_review',error=?,progress=? WHERE id=?",params:[JSON.stringify({...job.params,pipelineVersion:2}),'旧任务已补齐版本审查与提交步骤，请核对并继续',JSON.stringify({...job.progress,total:ordered.length}),job.id]},
    ]);
  }
}
