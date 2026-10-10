// TEST scripted planner and explicit author acceptance.
import { simulatedOutlineReview } from '../helpers/outlineReview';
import { listDocumentPlans, acceptDocumentPlan } from '@/db/repos/planProposalsRepo';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { sseBody, sseResponse } from '../llm/helpers';
import { setSecretStore } from '@/secrets/keychain';
import { setFetchImpl } from '@/llm/registry';
import { createProvider } from '@/db/repos/providersRepo';
import { createNovel, getNovel, updateNovel } from '@/db/repos/novelsRepo';
import { listChapters, upsertChapterPlan, createVersion, getVersion } from '@/db/repos/chaptersRepo';
import { listSnapshots, listArcs, upsertArc } from '@/db/repos/storylineRepo';
import { listBibleSnapshots } from '@/db/repos/bibleRepo';
import { getJob, listJobs, listSteps, createJob, setJobStatus, type Job } from '@/db/repos/jobsRepo';
import { listWritingCards } from '@/db/repos/writingRepo';
import { usageTotals } from '@/db/repos/usageRepo';
import { defaultRequirements } from '@/novel/types';
import { isPlanningJob, startChapterTable, startOutline, startPlanning } from '@/novel/service';
import { coveredUpTo, readBatchCache } from '@/jobs/steps/chapterTableStep';
import { retryStep, resumeJob } from '@/jobs/runner';
import { normalizeBatchEntries } from '@/novel/planning';
import type { FetchLike } from '@/llm/types';

const OUTLINE = {
  // TEST / SIMULATED planning output, not a real novel assessment.
  writing: {brief:{premise:'TEST',mainline:'TEST',ending:'TEST',audience:'TEST',constraints:[],rollingChapters:5,readingExperience:'TEST',distinctiveApproach:'TEST',protagonistLimits:'TEST',firstChoice:'TEST',choiceConsequences:'TEST',storyEngine:'TEST',endingConditions:'TEST'},volumes:[],intents:[{characterName:'阿水',goal:'TEST',motivation:'TEST',contradiction:'TEST',fear:'TEST',belief:'TEST',habitualStrategy:'TEST',independentAgenda:'TEST',growth:[]}]},
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

interface FakeOpts { failBatchOnce?: number; failReviewOnce?: boolean }

function makeFetch(opts: FakeOpts = {}) {
  const calls: string[] = [];
  const failed = new Set<number>();
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
    const done = { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 2000 } };
    const reply = (text: string) => sseResponse([sseBody([{ data: { choices: [{ delta: { content: text } }] } }, { data: done }, { data: '[DONE]' }])]);
    if (user.startsWith('请独立审查最终大纲')) { calls.push('review'); if (opts.failReviewOnce && !failed.has(-1)) { failed.add(-1); return new Response('{"error":{"message":"TEST independent review failed"}}', { status: 400 }); } return reply(JSON.stringify(simulatedOutlineReview())); }
    if (user.includes('章节表')) {
      const m = /请为第 (\d+)–(\d+) 章生成章节表/.exec(user);
      const from = Number(m![1]);
      calls.push(`table:${from}`);
      // 指定批次第一次调用时返回 400（不可重试），逼出「步骤失败 + 批次缓存」的路径
      if (opts.failBatchOnce === from && !failed.has(from)) {
        failed.add(from);
        return new Response('{"error":{"message":"nope"}}', { status: 400 });
      }
      const total = Number(user.match(/全书共 (\d+) 章/)?.[1] ?? 3);
      const threads = total>5 && user.includes('同时返回 threads 数组') ? [{title:'TEST 跨章信件',setup:'TEST 信封日期',progression:'TEST 核对邮戳',payoff:'TEST 日期得到解释',plannedChapterNo:total,characterNames:['阿水'],milestones:[{chapterNo:from,kind:'setup',detail:'TEST 日期疑问'},{chapterNo:from+3,kind:'progress',detail:'TEST 核对'},{chapterNo:total,kind:'payoff',detail:'TEST 解释'}]}] : undefined;
      return reply(JSON.stringify({ chapters: tableFor(from, Number(m![2])), threads }));
    }
    calls.push('outline');
    const count=Number(user.match(/约 (\d+) 章/)?.[1] ?? 3);
    return reply(JSON.stringify({...OUTLINE,arcs:OUTLINE.arcs.map(a=>({...a,endChapterNo:count}))}));
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
const terminal = (j: Job | null) => !!j && ['completed', 'failed', 'cancelled', 'paused', 'awaiting_review'].includes(j.status);
const waitJob = async (id: string) => {
 for (let i=0;i<4;i++){await waitFor(async()=>terminal(await getJob(id)));const job=(await getJob(id))!;if(job.status!=='awaiting_review')return job;const proposals=await listDocumentPlans(job.novelId);expect(proposals.length).toBeGreaterThan(0);for(const p of proposals)await acceptDocumentPlan(job.novelId,p.id);await resumeJob(id);}
 throw new Error('TEST too many acceptance rounds');
};

async function setup() {
  await createProvider({ name: 'fake', kind: 'openai_compatible', baseUrl: 'https://fake.local/v1', model: 'deepseek-chat', contextWindow: 32000, maxOutputTokens: 4000, jsonMode: 'json_object', temperature: 0.5, extraHeaders: {}, secretRef: 'env:FAKE_API_KEY' });
  return createNovel({ title: '未命名小说', premise: '一个少年沿河寻父', requirements: defaultRequirements(), targetChars: 9000, status: 'draft' });
}

beforeEach(() => {
  useTestDb();
  setSecretStore({ get: async () => 'k', set: async () => undefined, delete: async () => undefined });
});

describe('大纲与章节表改为后台任务（§2.1 第 1 条）', () => {
  it('TEST fills 100 chapters beside paused prose, preserves existing plans and stages cross-chapter threads', async () => {
    const scripted = makeFetch(); setFetchImpl(scripted.fetch);
    const novel = await setup();
    await waitJob(await startOutline(novel.id));
    const { updateNovel } = await import('@/db/repos/novelsRepo');
    await updateNovel(novel.id,{targetChars:300000});
    const arc=(await listArcs(novel.id))[0]!; await upsertArc(novel.id,{...arc,endChapterNo:100});
    for(let n=1;n<=100;n++) await upsertChapterPlan(novel.id,{chapterNo:n,title:n<=5?`TEST preserved ${n}`:'',goal:n<=5?`TEST goal ${n}`:'',targetChars:3000});
    const before = await listChapters(novel.id);
    const version = await createVersion({chapterId:before[0]!.id,content:'TEST existing prose, never overwrite.',source:'user_edit'});
    const writing = await createJob({novelId:novel.id,type:'generate_novel',providerId:null,params:{},steps:[{kind:'style_check',chapterId:before[0]!.id}]});
    await setJobStatus(writing.id,'paused');
    await expect(startChapterTable(novel.id)).rejects.toThrow('已有进行中的任务');
    const planning = await startChapterTable(novel.id,{fillMissing:true});
    await waitFor(async()=>terminal(await getJob(planning)));
    expect((await getJob(planning))!.status).toBe('awaiting_review');
    expect(scripted.calls).toEqual(['outline','review','table:6','table:36','table:66','table:96']);
    await expect(resumeJob(writing.id)).rejects.toThrow('先审阅或结束补充规划');
    expect((await listChapters(novel.id)).map(c=>c.title)).toEqual(before.map(c=>c.title));
    expect(await listWritingCards(novel.id,{kind:'thread'})).toHaveLength(0);
    const proposals = await listDocumentPlans(novel.id); expect(proposals).toHaveLength(1);
    await acceptDocumentPlan(novel.id,proposals[0]!.id);
    const after = await listChapters(novel.id);
    expect(after).toHaveLength(100); expect(after.every(c=>c.title.trim() && c.goal.trim())).toBe(true);
    expect(after.map(c=>c.id)).toEqual(before.map(c=>c.id));
    expect(after.slice(0,5).map(c=>[c.title,c.goal,c.targetChars])).toEqual(before.slice(0,5).map(c=>[c.title,c.goal,c.targetChars]));
    expect((await getVersion(version.id))!.content).toBe('TEST existing prose, never overwrite.');
    expect(after[0]!.currentVersionId).toBe(version.id);
    const threads = await listWritingCards(novel.id,{kind:'thread',confirmed:true});
    expect(threads).toHaveLength(1);
    expect(threads[0]!.kind==='thread' && threads[0]!.data.milestones?.map(m=>m.chapterNo)).toEqual([6,9,100]);
    expect((await getJob(writing.id))!.status).toBe('paused');
    expect((await getJob(planning))!.status).toBe('completed');
  });
  it('TEST accepted outline permits chapter planning at an awaiting-review prose checkpoint', async () => {
    setFetchImpl(makeFetch().fetch);
    const novel = await setup();
    await waitJob(await startOutline(novel.id));
    const saved = (await getNovel(novel.id))!;
    await updateNovel(novel.id, { meta: { ...saved.meta, storyOptionStage: 'outline', tableDone: false } }); // TEST author-adopted outline marker
    const writing = await createJob({ novelId: novel.id, type: 'generate_novel', providerId: null, params: {}, steps: [{ kind: 'write_chapter' }] });
    await setJobStatus(writing.id, 'awaiting_review');
    const planning = await startChapterTable(novel.id);
    expect((await getJob(planning))!.params.replanAfterOutline).toBe(true);
    expect((await waitJob(planning)).status).toBe('completed');
    expect((await getJob(writing.id))!.status).toBe('awaiting_review');
    expect((await getNovel(novel.id))!.meta.tableDone).toBe(true);
  });
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
    expect(chapters.reduce((s, c) => s + c.targetChars, 0)).toBe(3000); // TEST planner supplied 1000 per chapter; no forced rescaling to book quota.
    // 章节表跑完会落一份「generated」快照与第 0 号故事圣经
    expect((await listSnapshots(novel.id)).some((s) => s.reason === 'user_commit')).toBe(true);
    expect((await listBibleSnapshots(novel.id)).map((b) => b.afterChapterNo)).toEqual([]);
  });

  it('规划过程记账，用量能按任务查出来（§2.1 第 3 条）', async () => {
    setFetchImpl(makeFetch().fetch);
    const novel = await setup();
    const jobId = await startPlanning(novel.id);
    await waitJob(jobId);
    const totals = await usageTotals({ jobId });
    expect(totals.calls).toBe(3);
    expect(totals.inputTokens).toBe(3000);
    expect(totals.costCny).toBeGreaterThan(0);
  });

  it('TEST whole-book planning retries a failed batch without regenerating outline', async () => {
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
    expect(step.input.threadPlans).toHaveLength(1);
    expect(await listChapters(novel.id)).toHaveLength(0);
    const usedBefore = (await usageTotals({ jobId })).calls;

    await retryStep(step.id);
    expect((await waitJob(jobId)).status).toBe('completed');
    expect(await listChapters(novel.id)).toHaveLength(40);
    // 第一批只调用过一次：重试没有把它重跑一遍
    expect(f.calls.filter((c) => c === 'outline')).toHaveLength(1);
    expect(f.calls.filter((c) => c === 'table:1')).toHaveLength(1);
    expect(f.calls.filter((c) => c === 'table:31')).toHaveLength(2);
    expect((await listChapters(novel.id)).filter(c=>c.goal)).toHaveLength(40);
    expect((await usageTotals({ jobId })).calls).toBe(usedBefore + 1);
  });

  it('TEST replanning stages a proposal and preserves chapters after explicit adoption', async () => {
    setFetchImpl(makeFetch().fetch);
    const novel = await setup();
    await waitJob(await startPlanning(novel.id));
    expect(await listChapters(novel.id)).toHaveLength(3);

    expect((await listJobs({ novelId: novel.id })).length).toBe(1);
    const jobId = await startChapterTable(novel.id);
    await waitJob(jobId);
    expect((await listSnapshots(novel.id)).some((s) => s.reason === 'pre_rewrite')).toBe(true);
    expect(await listChapters(novel.id)).toHaveLength(3);
  });

  it('只跑大纲时不会碰章节表', async () => {
    const f = makeFetch();
    setFetchImpl(f.fetch);
    const novel = await setup();
    await waitJob(await startOutline(novel.id));
    expect(f.calls).toEqual(['outline','review']);
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
    expect(readBatchCache({batches:[{chapterNo:1,goal:'TEST goal without generated title'}]})[0]!.title).toBe('');
  });

  it('TEST missing AI chapter entries fail instead of fabricating defaults', () => {
    expect(()=>normalizeBatchEntries(tableFor(2,3),1,3,1000)).toThrow('缺少第 1 章');
  });
});

it('TEST outline-step retry resumes independent review without generating a second outline', async () => {
  useTestDb(); const scripted=makeFetch({failReviewOnce:true});setFetchImpl(scripted.fetch);
  const novel=await setup(), id=await startOutline(novel.id);
  expect((await waitJob(id)).status).toBe('failed');
  const step=(await listSteps(id))[0]!;
  expect(step.input.planProposalId).toBeTypeOf('string');
  expect((await listDocumentPlans(novel.id))[0]!.meta.outlineReview).toMatchObject({state:'failed'});
  await retryStep(step.id);expect((await waitJob(id)).status).toBe('completed');
  expect(scripted.calls).toEqual(['outline','review','review']);
});
