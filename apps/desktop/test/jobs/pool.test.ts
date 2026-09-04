import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDER_CONCURRENCY, planPoolStarts, poolGateId, taskGate, type PoolLimits } from '@/jobs/pool';
import { getRateGate, resetRateGates } from '@/llm/retry';

const limits = (over: Partial<PoolLimits> = {}): PoolLimits => ({ maxJobs: 2, perProvider: {}, defaultPerProvider: DEFAULT_PROVIDER_CONCURRENCY, ...over });

describe('任务池 / 聊天池分离', () => {
  it('任务侧用带 #task 后缀的 gate id，聊天侧仍用裸 providerId', () => {
    expect(poolGateId('p1', 'task')).toBe('p1#task');
    expect(poolGateId('p1', 'chat')).toBe('p1');
  });

  it('同一个供应商的任务闸门与聊天闸门是两个对象，互不排队', () => {
    resetRateGates();
    const t = taskGate('p1');
    const c = getRateGate('p1');
    expect(t).not.toBe(c);
    expect(t).toBe(taskGate('p1'));
    resetRateGates();
  });
});

describe('调度：这一轮能启动哪些任务', () => {
  it('受全局上限约束', () => {
    const jobs = [{ id: 'a', providerId: 'p1' }, { id: 'b', providerId: 'p2' }, { id: 'c', providerId: 'p3' }];
    expect(planPoolStarts(jobs, [], limits({ maxJobs: 2 }))).toEqual(['a', 'b']);
  });

  it('已经在跑的任务占掉名额', () => {
    const jobs = [{ id: 'b', providerId: 'p2' }, { id: 'c', providerId: 'p3' }];
    expect(planPoolStarts(jobs, [{ id: 'a', providerId: 'p1' }], limits({ maxJobs: 2 }))).toEqual(['b']);
  });

  it('供应商级并发数（llm_providers.concurrency）默认 1，同供应商不并行', () => {
    const jobs = [{ id: 'a', providerId: 'p1' }, { id: 'b', providerId: 'p1' }];
    expect(planPoolStarts(jobs, [], limits({ maxJobs: 4 }))).toEqual(['a']);
  });

  it('并发数配成 2 就能并行两个', () => {
    const jobs = [{ id: 'a', providerId: 'p1' }, { id: 'b', providerId: 'p1' }, { id: 'c', providerId: 'p1' }];
    expect(planPoolStarts(jobs, [], limits({ maxJobs: 4, perProvider: { p1: 2 } }))).toEqual(['a', 'b']);
  });

  it('同一本小说同时只跑一个任务', () => {
    const jobs = [{ id: 'a', providerId: 'p1' }, { id: 'b', providerId: 'p2' }, { id: 'c', providerId: 'p3' }];
    const novelOf = (id: string) => (id === 'c' ? 'n2' : 'n1');
    expect(planPoolStarts(jobs, [], limits({ maxJobs: 4 }), novelOf)).toEqual(['a', 'c']);
  });

  it('没指定供应商的任务共用「默认」这一档', () => {
    const jobs = [{ id: 'a', providerId: null }, { id: 'b', providerId: null }];
    expect(planPoolStarts(jobs, [], limits({ maxJobs: 4 }))).toEqual(['a']);
  });

  it('没有候选任务时返回空', () => {
    expect(planPoolStarts([], [], limits())).toEqual([]);
  });
});
