import { describe, expect, it } from 'vitest';
import { STEP_PURPOSE, STEP_PURPOSES, basePurposeOf, cleanProviderMap, pickProviderId, providerMapOf } from '@/jobs/purposes';

describe('步骤用途映射', () => {
  it('写作类步骤归到 writing，校读类各归各的', () => {
    expect(STEP_PURPOSE.write_chapter).toBe('writing');
    expect(STEP_PURPOSE.adjust_length).toBe('writing');
    expect(STEP_PURPOSE.rewrite_chapter).toBe('writing');
    expect(STEP_PURPOSE.summarize).toBe('summarize');
    expect(STEP_PURPOSE.style_check).toBe('styleReview');
    expect(STEP_PURPOSE.extract_style).toBe('extractStyle');
    expect(STEP_PURPOSE.outline).toBe('planning');
    expect(STEP_PURPOSE.chapter_table).toBe('planning');
  });

  it('只有 writing 回落到 registry 的写作档，其余都走便宜档', () => {
    expect(basePurposeOf('writing')).toBe('writing');
    for (const p of STEP_PURPOSES.filter((x) => x !== 'writing')) expect(basePurposeOf(p)).toBe('planning');
  });
});

describe('按用途挑供应商', () => {
  const global = { writing: 'g-w', summarize: 'g-s' };

  it('任务参数优先于任务列，任务列优先于全局设置', () => {
    expect(pickProviderId('writing', { job: { writing: 'j-w' }, global, jobProviderId: 'col-w' })).toBe('j-w');
    expect(pickProviderId('writing', { job: {}, global, jobProviderId: 'col-w' })).toBe('col-w');
    expect(pickProviderId('writing', { job: {}, global })).toBe('g-w');
  });

  it('provider_id 列只对 writing 生效，别的用途不会误用写作模型', () => {
    expect(pickProviderId('summarize', { job: {}, global: {}, jobProviderId: 'col-w' })).toBeNull();
    expect(pickProviderId('summarize', { job: {}, global, jobProviderId: 'col-w' })).toBe('g-s');
  });

  it('都没配就返回 null，交给 registry 兜底', () => {
    expect(pickProviderId('consistency', {})).toBeNull();
    expect(pickProviderId('consistency', { job: null, global: null })).toBeNull();
  });
});

describe('任务参数里的用途映射', () => {
  it('读得出合法项，忽略脏数据', () => {
    expect(providerMapOf({ providerIds: { writing: 'a', summarize: 3, nope: 'b', consistency: '' } })).toEqual({ writing: 'a' });
    expect(providerMapOf({ providerIds: ['x'] })).toEqual({});
    expect(providerMapOf({})).toEqual({});
    expect(providerMapOf(null)).toEqual({});
  });

  it('写回去之前会把空值清掉', () => {
    expect(cleanProviderMap({ writing: 'a', planning: null, styleReview: '' })).toEqual({ writing: 'a' });
    expect(cleanProviderMap(undefined)).toEqual({});
  });
});
