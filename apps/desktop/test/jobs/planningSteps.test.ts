import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { sseBody, sseResponse } from '../llm/helpers';
import { setSecretStore } from '@/secrets/keychain';
import { setFetchImpl } from '@/llm/registry';
import { createProvider } from '@/db/repos/providersRepo';
import { createNovel, getNovel } from '@/db/repos/novelsRepo';
import { listChapters } from '@/db/repos/chaptersRepo';
import { listSnapshots } from '@/db/repos/storylineRepo';
import { listBibleSnapshots } from '@/db/repos/bibleRepo';
import { getJob, listJobs, listSteps, type Job } from '@/db/repos/jobsRepo';
import { usageTotals } from '@/db/repos/usageRepo';
import { defaultRequirements } from '@/novel/types';
import { ConfirmRequiredError, isPlanningJob, startChapterTable, startOutline, startPlanning } from '@/novel/service';
import { coveredUpTo, readBatchCache } from '@/jobs/steps/chapterTableStep';
import { retryStep } from '@/jobs/runner';
import { normalizeBatchEntries } from '@/novel/planning';
import type { FetchLike } from '@/llm/types';

const OUTLINE = {
  title: '河的那一边',
  logline: '一个少年沿河寻父',
  themes: ['成长', '离别'],
  settings: [{ name: '渡口', kind: 'place', description: '河边唯一的渡口' }],
  characters: [{ name: '阿水', aliases: ['水娃'], role: '主角', description: '十六岁少年', arc: '从怯懦到担当', relationships: [] }],
  arcs: [{ title: '启程', summary: '离开村子', startChapterNo: 1, endChapterNo: 3 }],
  beats: [
    { arcIndex: 0, title: '渡口初遇', summary: '遇见老船夫', characterNames: ['阿水'], settingNames: ['渡口'], suggestedChapterNo: 1 },
    { arcIndex: 0, title: '暴雨夜', summary: '船翻了', characterNames: ['阿水'], settingNames: ['渡口'], suggestedChapterNo: 2 },
  ],
};

const tableFor = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({
    chapterNo: from + i,
    title: `第${from + i}节`,
    goal: '沿河前行',
    beatTitles: from + i === 1 ? ['渡口初遇'] : [],
    povCharacter: '阿水',
    targetChars: 1000,
    endHook: '天黑了',
  }));

interface FakeOpts { failBatchOnce?: number }

function makeFetch(opts: FakeOpts = {}) {
  const calls: string[] = [];
  const failed = new Set<number>();
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
    const done = { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 2000 } };
    const reply = (text: string) => sseResponse([sseBody([{ data: { choices: [{ delta: { content: text } }] } }, { data: done }, { data: '[DONE]' }])]);
    if (user.includes('章节表')) {
      const m = /请为第 (\d+)–(\d+) 章生成章节表/.exec(user);
      const from = Number(m![1]);
      calls.push(`table:${from}`);
      // 指定批次第一次调用时返回 400（不可重试），逼出「步骤失败 + 批次缓存」的路径
      if (opts.failBatchOnce === from && !failed.has(from)) {
        failed.add(from);
        return new Response('{"error":{"message":"nope"}}', { status: 400 });
      }
      return reply(JSON.stringify(tableFor(from, Number(m![2]))));
    }
    calls.push('outline');
    return reply(JSON.stringify(OUTLINE));
  };
  return { fetch, calls };
}

async function waitFor(pred: () => Promise<boolean>, ms = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('timeout');
}
const terminal = (j: Job | null) => !!j && ['completed', 'failed', 'cancelled', 'paused'].includes(j.status);
const waitJob = async (id: string) => { await waitFor(async () => terminal(await getJob(id))); return (await getJob(id))!; };

async function setup() {
  await createProvider({ name: 'fake', kind: 'openai_compatible', baseUrl: 'https://fake.local/v1', model: 'deepseek-chat', contextWindow: 32000, maxOutputTokens: 4000, jsonMode: 'json_object', temperature: 0.5, extraHeaders: {}, secretRef: 'env:FAKE_API_KEY' });
  return createNovel({ title: '未命名小说', premise: '一个少年沿河寻父', requirements: defaultRequirements(), targetChars: 9000, status: 'draft' });
}

beforeEach(() => {
  useTestDb();
  setSecretStore({ get: async () => 'k', set: async () => undefined, delete: async () => undefined });
});

describe('大纲与章节表改为后台任务（§2.1 第 1 条）', () => {
  it('规划任务把大纲与章节表都跑完并落库', async () => {
    setFetchImpl(makeFetch().fetch);
    const novel = await setup();
    const jobId = await startPlanning(novel.id);
    const job = await waitJob(jobId);
    expect(job.status).toBe('completed');
    expect(isPlanningJob(job)).toBe(true);
    expect((await listSteps(jobId)).map((s) => s.kind)).toEqual(['outline', 'chapter_table']);

    const after = (await getNovel(novel.id))!;
    expect(after.status).toBe('planning'); // 规划完还没开始写，状态不该跳到 writing
    expect(after.meta.outlineDone).toBe(true);
    expect(after.meta.tableDone).toBe(true);
    expect(after.title).toBe('河的那一边'); // 书名留空时用大纲里的
    expect(after.meta.logline).toBe('一个少年沿河寻父');

    const chapters = await listChapters(novel.id);
    expect(chapters).toHaveLength(3);
    expect(chapters[0]!.povCharacterId).not.toBeNull();
    expect(chapters[0]!.beatIds).toHaveLength(1);
    expect(chapters.reduce((s, c) => s + c.targetChars, 0)).toBe(9000);
    // 章节表跑完会落一份「generated」快照与第 0 号故事圣经
    expect((await listSnapshots(novel.id)).some((s) => s.reason === 'generated')).toBe(true);
    expect((await listBibleSnapshots(novel.id)).map((b) => b.afterChapterNo)).toEqual([0]);
  });

  it('规划过程记账，用量能按任务查出来（§2.1 第 3 条）', async () => {
    setFetchImpl(makeFetch().fetch);
    const novel = await setup();
    const jobId = await startPlanning(novel.id);
    await waitJob(jobId);
    const totals = await usageTotals({ jobId });
    expect(totals.calls).toBe(2);
    expect(totals.inputTokens).toBe(2000);
    expect(totals.costCny).toBeGreaterThan(0);
  });

  it('第二批失败后单步重试：第一批的结果从缓存里复用，不重复计费', async () => {
    const f = makeFetch({ failBatchOnce: 31 });
    setFetchImpl(f.fetch);
    await createProvider({ name: 'fake', kind: 'openai_compatible', baseUrl: 'https://fake.local/v1', model: 'deepseek-chat', contextWindow: 32000, maxOutputTokens: 4000, jsonMode: 'json_object', temperature: 0.5, extraHeaders: {}, secretRef: 'env:FAKE_API_KEY' });
    // 40 章 → 章节表分两批（每批 30 章）
    const novel = await createNovel({ title: '长', premise: 'x', requirements: defaultRequirements(), targetChars: 120000, status: 'draft' });
    const jobId = await startPlanning(novel.id);
    expect((await waitJob(jobId)).status).toBe('failed');

    const step = (await listSteps(jobId)).find((s) => s.kind === 'chapter_table')!;
    expect(step.status).toBe('failed');
    // 第一批已经落盘，章节表还没写进 chapters（全部批次跑完才动数据库）
    expect(readBatchCache(step.input)).toHaveLength(30);
    expect(await listChapters(novel.id)).toHaveLength(0);
    const usedBefore = (await usageTotals({ jobId })).calls;

    await retryStep(step.id);
    expect((await waitJob(jobId)).status).toBe('completed');
    expect(await listChapters(novel.id)).toHaveLength(40);
    // 第一批只调用过一次：重试没有把它重跑一遍
    expect(f.calls.filter((c) => c === 'table:1')).toHaveLength(1);
    expect(f.calls.filter((c) => c === 'table:31')).toHaveLength(2);
    expect((await usageTotals({ jobId })).calls).toBe(usedBefore + 1);
  });

  it('已有章节时重排必须二次确认，确认后自动落 pre_rewrite 快照', async () => {
    setFetchImpl(makeFetch().fetch);
    const novel = await setup();
    await waitJob(await startPlanning(novel.id));
    expect(await listChapters(novel.id)).toHaveLength(3);

    await expect(startChapterTable(novel.id)).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect((await listJobs({ novelId: novel.id })).length).toBe(1); // 没有偷偷建任务

    const jobId = await startChapterTable(novel.id, { confirmReplaceChapters: true });
    await waitJob(jobId);
    expect((await listSnapshots(novel.id)).some((s) => s.reason === 'pre_rewrite')).toBe(true);
    expect(await listChapters(novel.id)).toHaveLength(3);
  });

  it('只跑大纲时不会碰章节表', async () => {
    const f = makeFetch();
    setFetchImpl(f.fetch);
    const novel = await setup();
    await waitJob(await startOutline(novel.id));
    expect(f.calls).toEqual(['outline']);
    expect((await getNovel(novel.id))!.meta.tableDone).toBe(false);
    expect(await listChapters(novel.id)).toHaveLength(0);
  });
});

describe('章节表批次缓存（纯函数）', () => {
  it('只认连续的前缀，缺口之后的批次会重跑', () => {
    const cache = [{ chapterNo: 1 }, { chapterNo: 2 }, { chapterNo: 5 }].map((e) => ({ ...e, title: '', goal: '', beatTitles: [], povCharacter: null, targetChars: 0, endHook: '' }));
    expect(coveredUpTo(cache)).toBe(2);
  });

  it('脏数据一律当作没缓存', () => {
    expect(readBatchCache({ batches: 'nope' })).toEqual([]);
    expect(readBatchCache({})).toEqual([]);
    expect(readBatchCache({ batches: [{ chapterNo: 'x' }, null, { chapterNo: 1 }] })).toHaveLength(1);
  });

  it('缺的章号会补默认条目，越界的会被丢掉', () => {
    const out = normalizeBatchEntries([
      { chapterNo: 2, title: 'b', goal: '', beatTitles: [], povCharacter: null, targetChars: 900, endHook: '' },
      { chapterNo: 9, title: '越界', goal: '', beatTitles: [], povCharacter: null, targetChars: 900, endHook: '' },
    ], 1, 3, 1000);
    expect(out.map((e) => e.chapterNo)).toEqual([1, 2, 3]);
    expect(out[0]!.title).toBe('第1章');
    expect(out[1]!.title).toBe('b');
  });
});
