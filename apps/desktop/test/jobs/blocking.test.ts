import { describe, expect, it } from 'vitest';
import { BLOCKING_JOB_STATUSES, isBlockingJob, type Job, type JobStatus } from '@/db/repos/jobsRepo';
import { activeJobsForNovel, blockingJobForNovel } from '@/stores/jobsStore';

const ALL: JobStatus[] = ['queued', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'failed', 'completed', 'awaiting_review'];

const job = (id: string, status: JobStatus, novelId = 'n1', createdAt = 1): Job => ({
  id, novelId, type: 'generate_novel', status, params: {}, providerId: null,
  progress: { done: 0, total: 0, currentStepId: null, charsSoFar: 0, message: '' },
  error: null, createdAt, updatedAt: createdAt,
} as Job);

const index = (list: Job[]) => Object.fromEntries(list.map((j) => [j.id, j]));

describe('阻塞判定：界面与服务层必须同源', () => {
  it('只有 queued / running / pausing / paused 算阻塞', () => {
    expect([...BLOCKING_JOB_STATUSES]).toEqual(['queued', 'running', 'pausing', 'paused', 'awaiting_review']);
    for (const s of ALL) {
      expect(isBlockingJob(s)).toBe((['queued', 'running', 'pausing', 'paused', 'awaiting_review'] as JobStatus[]).includes(s));
    }
  });

  it('失败的任务不锁死章节工具栏', () => {
    // 曾经的 bug：界面把 failed 也算作「有任务在跑」，按钮全灰，
    // 但服务层的 ensureNoActiveJob 根本不拦 failed，用户只能干瞪眼。
    const jobs = index([job('j1', 'failed')]);
    expect(blockingJobForNovel(jobs, 'n1')).toBeNull();
    expect(activeJobsForNovel(jobs, 'n1')).toHaveLength(1); // 流式展示那一路仍看得到它
  });

  it('cancelling 同理不阻塞', () => {
    expect(blockingJobForNovel(index([job('j1', 'cancelling')]), 'n1')).toBeNull();
  });

  it('暂停中的任务确实阻塞（与 ensureNoActiveJob 一致）', () => {
    expect(blockingJobForNovel(index([job('j1', 'paused')]), 'n1')?.id).toBe('j1');
  });

  it('只看本书的任务，且取最近一个', () => {
    const jobs = index([job('old', 'queued', 'n1', 1), job('new', 'running', 'n1', 9), job('other', 'running', 'n2', 5)]);
    expect(blockingJobForNovel(jobs, 'n1')?.id).toBe('new');
    expect(blockingJobForNovel(jobs, 'n3')).toBeNull();
  });

  it('已完成 / 已取消都不阻塞', () => {
    expect(blockingJobForNovel(index([job('a', 'completed'), job('b', 'cancelled')]), 'n1')).toBeNull();
  });
});
