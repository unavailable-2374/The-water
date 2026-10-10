import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { createJob, getJob, listSteps, setJobStatus } from '@/db/repos/jobsRepo';
import { createNovel } from '@/db/repos/novelsRepo';
import { defaultRequirements } from '@/novel/types';
import { describeStepError, kick } from '@/jobs/runner';
import { LLMError } from '@/llm/types';

// TEST in-memory database. No real model request or credentials are used.
let db: ReturnType<typeof useTestDb>;
beforeEach(() => { db = useTestDb(undefined, 'server'); });
afterEach(() => { db.raw.close(); });
async function job() {
  const novel = await createNovel({ title: 'TEST authentication regression', premise: 'TEST', requirements: defaultRequirements(), targetChars: 1000, status: 'planning' });
  return createJob({ novelId: novel.id, type: 'generate_novel', params: {}, providerId: null, steps: [{ kind: 'outline' }] });
}
describe('TEST task authentication and error lifecycle', () => {
  it('explicit null clears stale errors while omitted and undefined fields preserve them', async () => {
    const j = await job();
    await setJobStatus(j.id, 'failed', { error: 'TEST previous authentication failure' });
    await setJobStatus(j.id, 'paused');
    expect((await getJob(j.id))?.error).toBe('TEST previous authentication failure');
    await setJobStatus(j.id, 'paused', { error: undefined });
    expect((await getJob(j.id))?.error).toBe('TEST previous authentication failure');
    await setJobStatus(j.id, 'running', { error: null });
    expect((await getJob(j.id))?.error).toBeNull();
    expect((await getJob(j.id))?.finishedAt).toBeNull();
    await setJobStatus(j.id, 'failed', { error: 'TEST new failure' });
    expect((await getJob(j.id))?.error).toBe('TEST new failure');
  });
  it('missing cloud login fails both job and step immediately instead of appearing to keep writing', async () => {
    const j = await job();
    kick();
    await vi.waitFor(async () => expect((await getJob(j.id))?.status).toBe('failed'));
    const failed = await getJob(j.id);
    const steps = await listSteps(j.id);
    expect(failed?.error).toContain('请先在设置中登录云端账号');
    expect(failed?.error).not.toContain('API Key 无效');
    expect(steps[0]?.status).toBe('failed');
    expect(steps[0]?.attempts).toBe(1);
  });
  it('authentication errors retain the actual cause without asserting a provider API key is invalid', () => {
    expect(describeStepError(new LLMError('auth', 'TEST cloud session expired'))).toBe('身份验证失败：TEST cloud session expired');
    expect(describeStepError(new LLMError('auth', 'TEST provider rejected key'))).toBe('身份验证失败：TEST provider rejected key');
  });
});
