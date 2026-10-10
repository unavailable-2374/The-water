import { testFirstReading } from '../helpers/writing';
import { testReadyLengthReview, testReadyStory } from '../helpers/writing';
// TEST: scripted provider exercises persistence, not model quality.
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { sseBody, sseResponse } from '../llm/helpers';
import { setSecretStore } from '@/secrets/keychain';
import { setFetchImpl } from '@/llm/registry';
import { createProvider } from '@/db/repos/providersRepo';
import { createNovel } from '@/db/repos/novelsRepo';
import { createVersion, listChapters, listVersions, upsertChapterPlan } from '@/db/repos/chaptersRepo';
import { createSnapshot, replaceStorylineRows } from '@/db/repos/storylineRepo';
import { saveBible } from '@/db/repos/bibleRepo';
import { createJob, getJob, listSteps, setJobStatus, stepDone, stepPartial, type Job } from '@/db/repos/jobsRepo';
import { emptyBible, emptyStoryline, emptyVoice } from '@the-water/shared';
import { defaultRequirements } from '@/novel/types';
import { planGenerate } from '@/jobs/planner';
import { canActOnStep, kick, resumeJob, retryStep, skipStep } from '@/jobs/runner';
import { passKey } from '@/jobs/steps/common';
import { trimToSentenceEnd } from '@/jobs/resume';
import type { ChatMessage, FetchLike } from '@/llm/types';

const sentence = '风从河面吹过来，带着水草的气味。';
const prose = (chars: number) => sentence.repeat(Math.ceil(chars / sentence.length));

interface Recorded { json: boolean; messages: ChatMessage[] }

/** OpenAI-compatible 假供应商：JSON 请求走总结分支，其余按脚本吐正文。 */
function makeFetch(opts: { proseChars?: number[]; failJsonOnce?: boolean; failProseOnce?: boolean } = {}) {
  const calls: Recorded[] = [];
  let proseCalls = 0;
  let jsonCalls = 0;
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: ChatMessage[]; response_format?: unknown };
    const isJson = !!body.response_format;
    calls.push({ json: isJson, messages: body.messages });
    const done = { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } };
    const reply = (text: string) => sseResponse([sseBody([{ data: { choices: [{ delta: { content: text } }] } }, { data: done }, { data: '[DONE]' }])]);
    if (isJson) {
      const system = body.messages.find(m => m.role === 'system')?.content ?? '';
      if(system.includes('第一次阅读作品')) return reply(JSON.stringify(testFirstReading()));
      if (system.includes('叙事审稿')) return reply(JSON.stringify({ readerAlignment:[], issues: [], lengthReview:testReadyLengthReview(), story:testReadyStory() }));
      jsonCalls++;
      if (opts.failJsonOnce && jsonCalls === 1) return new Response('{"error":{"message":"nope"}}', { status: 400 });
      return reply(JSON.stringify({
        summary: '主角来到河边。',
        events: [],
      }));
    }
    proseCalls++;
    if (opts.failProseOnce && proseCalls === 1) return reply('太短');
    const want = opts.proseChars?.[proseCalls - 1] ?? 260;
    return reply(prose(want));
  };
  return { fetch, calls, proseCount: () => proseCalls };
}

async function waitFor(pred: () => Promise<boolean>, ms = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('timeout');
}
const terminal = (j: Job | null) => !!j && ['completed', 'failed', 'cancelled', 'paused', 'awaiting_review'].includes(j.status);
const waitJob = async (id: string) => { await waitFor(async () => terminal(await getJob(id))); return (await getJob(id))!; };

async function setupNovel(chapterCount: number, targetChars = 250, docType = 'long-webnovel') {
  await createProvider({ name: 'fake', kind: 'openai_compatible', baseUrl: 'https://fake.local/v1', model: 'deepseek-chat', contextWindow: 32000, maxOutputTokens: 4000, jsonMode: 'json_object', temperature: 0.5, extraHeaders: {}, secretRef: 'env:FAKE_API_KEY' });
  const novel = await createNovel({ title: '河', premise: '一个少年沿河寻父', requirements: {...defaultRequirements(),docType}, targetChars: targetChars * chapterCount, status: 'planning' });
  const doc = { ...emptyStoryline(), premise: novel.premise, characters: [{ id: 'c1', name: '阿水', aliases: [], role: '主角', description: '十六岁少年', arc: '', relationships: [], ...emptyVoice() }] };
  await replaceStorylineRows(novel.id, doc);
  for (let n = 1; n <= chapterCount; n++) await upsertChapterPlan(novel.id, { chapterNo: n, title: `第${n}章`, goal: '沿河前行', targetChars, povCharacterId: 'c1' });
  await createSnapshot(novel.id, doc, 'generated');
  await saveBible(novel.id, 0, emptyBible());
  return novel;
}

async function startJob(novelId: string) {
  const job = await createJob({ novelId, type: 'generate_novel', params: {}, providerId: null, steps: planGenerate(await listChapters(novelId), { fiction: false }) });
  await setJobStatus(job.id, 'running');
  return job;
}

beforeEach(() => {
  useTestDb();
  setSecretStore({ get: async () => 'k', set: async () => undefined, delete: async () => undefined });
});

describe('单步重试 / 单步跳过（§2.1 第 6 条）', () => {
  it('不可重试的失败让任务停下，单步重试只重跑那一步', async () => {
    const f = makeFetch({ failJsonOnce: true });
    setFetchImpl(f.fetch);
    const novel = await setupNovel(1);
    const job = await startJob(novel.id);
    kick();
    expect((await waitJob(job.id)).status).toBe('failed');
    const failed = (await listSteps(job.id)).find((s) => s.status === 'failed')!;
    expect(failed.kind).toBe('summarize');
    // 400 不该被自动重试：白烧钱
    expect(failed.attempts).toBe(1);
    const proseBefore = f.proseCount();

    await retryStep(failed.id);
    expect((await waitJob(job.id)).status).toBe('completed');
    // 正文没有重写，只重跑了总结
    expect(f.proseCount()).toBe(proseBefore);
    expect((await listSteps(job.id)).every((s) => s.status === 'done')).toBe(true);
  });

  it('TEST mandatory extraction cannot be skipped', async () => {
    setFetchImpl(makeFetch({ failJsonOnce: true }).fetch);
    const novel = await setupNovel(1);
    const job = await startJob(novel.id);
    kick();
    expect((await waitJob(job.id)).status).toBe('failed');
    const failed = (await listSteps(job.id)).find((s) => s.status === 'failed')!;

    await expect(skipStep(failed.id)).rejects.toThrow();
    expect((await getJob(job.id))!.status).toBe('failed');
    expect((await listSteps(job.id)).find(s => s.id === failed.id)!.status).toBe('failed');
  });

  it('可重试的失败由步骤级自动重试兜住，attempts 记下重试次数', async () => {
    const f = makeFetch({ failProseOnce: true });
    setFetchImpl(f.fetch);
    const novel = await setupNovel(1);
    const job = await startJob(novel.id);
    kick();
    expect((await waitJob(job.id)).status).toBe('completed');
    const write = (await listSteps(job.id)).find((s) => s.kind === 'write_chapter')!;
    expect(write.attempts).toBe(2); // 第一次「正文过短」，自动重试一次就成了
    expect(write.status).toBe('done');
  });

  it('只有失败 / 跳过的步骤才给重试与跳过按钮', () => {
    const step = (status: string) => ({ status }) as never;
    expect(canActOnStep({ status: 'failed' }, step('failed'))).toBe(true);
    expect(canActOnStep({ status: 'completed' }, step('skipped'))).toBe(true);
    expect(canActOnStep({ status: 'failed' }, step('done'))).toBe(false);
    expect(canActOnStep({ status: 'cancelled' }, step('failed'))).toBe(false);
  });
});

describe('adjust_length 每个 pass 独立幂等（§2.1 第 7 条）', () => {
  it('TEST an oversized fiction chapter is preserved without automatic trimming',async()=>{
    const f=makeFetch({proseChars:[8000,6000,3300]});setFetchImpl(f.fetch);
    const novel=await setupNovel(1,3333),job=await startJob(novel.id);kick();
    expect((await waitJob(job.id)).status).toBe('completed');
    const adjust=(await listSteps(job.id)).find(s=>s.kind==='adjust_length')!;
    const versions=await listVersions((await listChapters(novel.id))[0]!.id);
    expect(versions.map(v=>v.jobStepId)).not.toContain(passKey(adjust.id,1));
    expect(versions).toHaveLength(1); expect(versions[0]!.charCount).toBeGreaterThan(7900);
    expect(f.proseCount()).toBe(1);
  });
  it('TEST two unsuccessful trim passes preserve prose and wait instead of claiming the budget passed',async()=>{
    const f=makeFetch({proseChars:[8000,7000,6000]});setFetchImpl(f.fetch);
    const novel=await setupNovel(1,3333,'tech-blog'),job=await startJob(novel.id);kick();
    const stopped=await waitJob(job.id);
    expect(stopped.status).toBe('awaiting_review');expect(stopped.error).toContain('仍超出字数范围');
    expect((await listChapters(novel.id))[0]?.committedVersionId).toBeNull();
    expect((await listVersions((await listChapters(novel.id))[0]!.id))[0]?.charCount).toBeGreaterThan(5900);
    expect(f.calls.some(c=>c.json)).toBe(false);
    const chapter=(await listChapters(novel.id))[0]!;
    const author=await createVersion({chapterId:chapter.id,content:prose(3300),source:'user_edit'});
    await resumeJob(job.id);kick();
    expect((await waitJob(job.id)).status).toBe('completed');
    expect((await listChapters(novel.id))[0]?.committedVersionId).toBe(author.id);
    expect(f.proseCount()).toBe(3);
  });
  it('两轮扩写各自落一个版本，键分别是 #0 / #1', async () => {
    setFetchImpl(makeFetch({ proseChars: [600, 1200, 1800] }).fetch);
    const novel = await setupNovel(1, 2000, 'tech-blog');
    const job = await startJob(novel.id);
    kick();
    expect((await waitJob(job.id)).status).toBe('completed');
    const adjust = (await listSteps(job.id)).find((s) => s.kind === 'adjust_length')!;
    const versions = await listVersions((await listChapters(novel.id))[0]!.id);
    const keys = versions.map((v) => v.jobStepId);
    expect(keys).toContain(passKey(adjust.id, 0));
    expect(keys).toContain(passKey(adjust.id, 1));
  });

  it('崩在两轮之间：第一轮的版本被认出来，只重跑第二轮', async () => {
    const f = makeFetch({ proseChars: [1800] });
    setFetchImpl(f.fetch);
    const novel = await setupNovel(1, 2000, 'tech-blog');
    const chapter = (await listChapters(novel.id))[0]!;
    const job = await startJob(novel.id);
    const steps = await listSteps(job.id);
    const write = steps.find((s) => s.kind === 'write_chapter')!;
    const adjust = steps.find((s) => s.kind === 'adjust_length')!;
    // 模拟：write_chapter 已完成，adjust_length 的第一轮也产出了版本，然后应用崩了
    await createVersion({ chapterId: chapter.id, content: prose(600), source: 'generated', jobStepId: write.id });
    await stepDone(write.id, null);
    await createVersion({ chapterId: chapter.id, content: prose(1200), source: 'topup', jobStepId: passKey(adjust.id, 0) });

    kick();
    expect((await waitJob(job.id)).status).toBe('completed');
    // 只调了一次正文接口：第二轮。第一轮直接复用了已有版本，没有重复计费
    expect(f.proseCount()).toBe(1);
    const keys = (await listVersions(chapter.id)).map((v) => v.jobStepId);
    expect(keys.filter((k) => k === passKey(adjust.id, 0))).toHaveLength(1);
    expect(keys).toContain(passKey(adjust.id, 1));
  });

  it('老数据里第一轮用的是裸 stepId，也照样认', async () => {
    const f = makeFetch({ proseChars: [1800] });
    setFetchImpl(f.fetch);
    const novel = await setupNovel(1, 2000, 'tech-blog');
    const chapter = (await listChapters(novel.id))[0]!;
    const job = await startJob(novel.id);
    const steps = await listSteps(job.id);
    const write = steps.find((s) => s.kind === 'write_chapter')!;
    const adjust = steps.find((s) => s.kind === 'adjust_length')!;
    await createVersion({ chapterId: chapter.id, content: prose(600), source: 'generated', jobStepId: write.id });
    await stepDone(write.id, null);
    await createVersion({ chapterId: chapter.id, content: prose(1200), source: 'topup', jobStepId: adjust.id });

    kick();
    expect((await waitJob(job.id)).status).toBe('completed');
    expect(f.proseCount()).toBe(1);
  });
});

describe('续写复用已生成文本（§2.1 第 4 条）', () => {
  it('TEST short fiction is not padded automatically, while explicit author expansion remains available',async()=>{
    const f=makeFetch({proseChars:[1800]});setFetchImpl(f.fetch);
    const novel=await setupNovel(1,2000),chapter=(await listChapters(novel.id))[0]!;
    const draft=await createVersion({chapterId:chapter.id,content:prose(600),source:'generated'});
    const automatic=await createJob({novelId:novel.id,type:'generate_novel',params:{},providerId:null,steps:[{kind:'adjust_length',chapterId:chapter.id,input:{}}]});
    kick();expect((await waitJob(automatic.id)).status).toBe('completed');
    expect(f.proseCount()).toBe(0);
    expect((await listChapters(novel.id))[0]!.currentVersionId).toBe(draft.id);
    const forced=await createJob({novelId:novel.id,type:'rewrite',params:{},providerId:null,steps:[{kind:'adjust_length',chapterId:chapter.id,input:{force:'expand'}}]});
    kick();expect((await waitJob(forced.id)).status).toBe('completed');expect(f.proseCount()).toBe(1);
  });
  it('半成品够长时以 assistant 前缀续写，成稿从断点接上', async () => {
    const f = makeFetch({ proseChars: [400] });
    setFetchImpl(f.fetch);
    const novel = await setupNovel(1, 2000, 'tech-blog');
    const chapter = (await listChapters(novel.id))[0]!;
    const job = await startJob(novel.id);
    const write = (await listSteps(job.id)).find((s) => s.kind === 'write_chapter')!;
    const partial = prose(400);
    await stepPartial(write.id, partial);

    kick();
    await waitJob(job.id);
    const first = f.calls.find((c) => !c.json)!;
    const assistant = first.messages.filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.content).toBe(trimToSentenceEnd(partial));
    expect(first.messages.some((m) => m.role === 'user' && m.content.includes('已经写好的部分'))).toBe(true);
    const version = (await listVersions(chapter.id)).find((v) => v.jobStepId === write.id)!;
    expect(version.content.startsWith(trimToSentenceEnd(partial))).toBe(true);
  });

  it('半成品太短时不续写，照常从头生成', async () => {
    const f = makeFetch();
    setFetchImpl(f.fetch);
    const novel = await setupNovel(1);
    const job = await startJob(novel.id);
    const write = (await listSteps(job.id)).find((s) => s.kind === 'write_chapter')!;
    await stepPartial(write.id, '只写了半句');

    kick();
    await waitJob(job.id);
    expect(f.calls.find((c) => !c.json)!.messages.some((m) => m.role === 'assistant')).toBe(false);
  });
});
