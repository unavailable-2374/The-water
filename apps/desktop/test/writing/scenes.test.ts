/** TEST scripted outputs only. This exercises recovery/atomicity, not literary quality. */
import { beforeEach, expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { createNovel } from '@/db/repos/novelsRepo';
import { getChapter, getVersion, upsertChapterPlan } from '@/db/repos/chaptersRepo';
import { createJob, listSteps } from '@/db/repos/jobsRepo';
import { listPlanProposals, proposeCard, saveWritingCard } from '@/db/repos/writingRepo';
import { getDb } from '@/db/db';
import { defaultRequirements } from '@/novel/types';
import { scenePlanStep, writeScenesStep } from '@/jobs/steps/sceneSteps';
import { RateGate } from '@/llm/retry';
import type { StepContext } from '@/jobs/context';
import type { CompletionRequest, LLMProvider } from '@/llm/types';
import { LLMError } from '@/llm/types';
import { sceneReferenceIssues } from '@/novel/sceneReferences';
import { PLOT_PLANNING_RULE } from '@/novel/plotDesign';
const scene = {
  title: 'TEST scene', readerInterest:'TEST reader concern',choice:'TEST active choice',choiceReason:'TEST triggering information',consequence:'TEST consequence',beforeState:'TEST before',afterState:'TEST after',presentation:'dramatize' as const,
  volumeId: null,
  povCharacterId: null,
  time: 'TEST morning',
  location: 'TEST room',
  characterIds: [],
  goal: 'TEST goal',
  obstacle: 'TEST obstacle',
  turn: 'TEST turn',
  outcome: 'TEST result',
  targetChars: 250,
  dependencyIds: [],
  threadIds: [],
};
beforeEach(() => useTestDb());
it('TEST scheduled thread stages reach the rolling planner and omitted references require repair', async () => {
  const f=await fixture('scene_plan',3);
  const id=await saveWritingCard(f.novel.id,{kind:'thread',data:{title:'TEST cross-chapter question',setup:'TEST setup',progression:'TEST progress',payoff:'TEST payoff',plannedChapterNo:3,characterIds:[],milestones:[{chapterNo:1,kind:'setup',detail:'TEST unexplained letter'},{chapterNo:2,kind:'progress',detail:'TEST compare dates'},{chapterNo:3,kind:'payoff',detail:'TEST explain dates'}]}},{confirmed:true});
  let calls=0;
  f.respond(async()=>JSON.stringify({chapters:f.chapters.map(c=>({chapterId:c.id,scenes:[{...scene,threadIds:++calls<=3?[]:[id]}]}))}));
  await expect(scenePlanStep(f.ctx)).rejects.toThrow('章节页审阅并采纳');
  expect(f.requests).toHaveLength(2);
  expect(f.requests[0]!.messages.at(-1)!.content).toContain('TEST unexplained letter');
  expect(f.requests[0]!.messages[0]!.content).toContain('不得将未来 payoff 提前');
  expect(f.requests[0]!.messages[0]!.content.split(PLOT_PLANNING_RULE)).toHaveLength(2);
  const proposals=await listPlanProposals(f.novel.id);expect(proposals).toHaveLength(3);
  expect(proposals.every(p=>p.card.kind==='scene' && p.card.data.threadIds.includes(id))).toBe(true);
});
it('TEST scene reference types and volume ranges stay distinct', () => {
  const refs = { characterIds: new Set(['TEST-person']), volumes: new Map([['TEST-volume', { startChapterNo: 1, endChapterNo: 2 }]]), threadIds: new Set(['TEST-thread']), factIds: new Set(['TEST-fact']) };
  expect(sceneReferenceIssues({ ...scene, povCharacterId: 'TEST-person', characterIds: ['TEST-person'], volumeId: 'TEST-volume', threadIds: ['TEST-thread'], dependencyIds: ['TEST-fact'] }, refs, 2)).toEqual([]);
  expect(sceneReferenceIssues({ ...scene, povCharacterId: 'TEST-setting', characterIds: ['TEST-setting'], volumeId: 'TEST-volume', threadIds: ['TEST-setting'], dependencyIds: ['TEST-setting'] }, refs, 3).map(i => i.field)).toEqual(['povCharacterId', 'characterIds', 'volumeId', 'threadIds', 'dependencyIds']);
});
async function fixture(kind: 'scene_plan' | 'write_scenes', count = 1, genrePackIds: string[] = []) {
  const novel = await createNovel({
    title: 'TEST scene pipeline',
    premise: 'TEST fictional',
    requirements: { ...defaultRequirements(), genrePackIds },
    targetChars: count * 500,
  });
  const chapters = [];
  for (let i = 1; i <= count; i++)
    chapters.push(await upsertChapterPlan(novel.id, { chapterNo: i, title: `TEST ${i}`, targetChars: 500 }));
  const job = await createJob({
    novelId: novel.id,
    type: 'generate_novel',
    providerId: null,
    params: {},
    steps: [{ kind, chapterId: chapters[0]!.id, input: {} }],
  });
  const step = (await listSteps(job.id))[0]!;
  const requests: CompletionRequest[] = [];
  let respond: () => Promise<string> = async () => {
    throw new Error('TEST response missing');
  };
  const provider: LLMProvider = {
    id: 'TEST scenes',
    kind: 'openai_compatible',
    model: 'TEST',
    caps: { contextWindow: 128000, maxOutputTokens: 16000, jsonMode: 'json_object', cjkTokenRatio: 0.7 },
    async *stream(request) {
      requests.push(request);
      yield { type: 'delta', text: await respond() };
      yield { type: 'done', finishReason: 'stop' };
    },
  };
  const ctx: StepContext = {
    job,
    step,
    provider,
    purpose: 'writing',
    gate: new RateGate('TEST scenes'),
    signal: new AbortController().signal,
    providerFor: async () => provider,
    recordUsage: async () => {},
    takeResumeSeed: () => null,
    onDelta: () => {},
    setMessage: () => {},
  };
  return {
    novel,
    chapters,
    ctx,
    requests,
    respond: (fn: () => Promise<string>) => {
      respond = fn;
    },
  };
}
it('TEST rolling scene planning excludes existing proposals and rolls back an interrupted batch', async () => {
  const f = await fixture('scene_plan', 3);
  await proposeCard(f.novel.id, { kind: 'scene', data: scene }, f.chapters[2]!.id);
  f.respond(async () =>
    JSON.stringify({ chapters: f.chapters.slice(0, 2).map((c) => ({ chapterId: c.id, scenes: [scene] })) }),
  );
  await getDb().execute(
    `CREATE TRIGGER test_scene_interrupt BEFORE INSERT ON writing_proposals WHEN NEW.chapter_id='${f.chapters[1]!.id}' BEGIN SELECT RAISE(ABORT,'TEST scene batch interrupted'); END`,
  );
  await expect(scenePlanStep(f.ctx)).rejects.toThrow('TEST scene batch interrupted');
  expect(await listPlanProposals(f.novel.id)).toHaveLength(1);
  await getDb().execute('DROP TRIGGER test_scene_interrupt');
  await expect(scenePlanStep(f.ctx)).rejects.toThrow('章节页审阅并采纳');
  expect(await listPlanProposals(f.novel.id)).toHaveLength(3);
  expect(f.requests[0]!.messages.at(-1)!.content.split('待规划章节：')[1] ?? '').not.toContain(
    f.chapters[2]!.id,
  );
});
it('TEST invalid factual dependencies are repaired before any candidate is staged', async () => {
  const f = await fixture('scene_plan');
  let calls = 0;
  f.respond(async () => {
    calls++;
    expect(await listPlanProposals(f.novel.id)).toHaveLength(0);
    return JSON.stringify({ chapters: [{ chapterId: f.chapters[0]!.id, scenes: [{ ...scene, dependencyIds: calls === 1 ? ['TEST-setting-is-not-a-fact'] : [] }] }] });
  });
  await expect(scenePlanStep(f.ctx)).rejects.toThrow('章节页审阅并采纳');
  expect(calls).toBe(2);
  expect(f.requests[0]!.messages[0]!.content).toContain('事实列表为空必须填 []');
  expect(f.requests[1]!.messages.at(-1)!.content).toContain('canonEvents');
  expect(await listPlanProposals(f.novel.id)).toHaveLength(1);
});
it('TEST multi-scene recovery reuses complete scenes and links them before creating one candidate', async () => {
  const f = await fixture('write_scenes');
  const chapter = f.chapters[0]!;
  for (let i = 0; i < 2; i++)
    await saveWritingCard(
      f.novel.id,
      { kind: 'scene', data: { ...scene, title: `TEST scene ${i}` } },
      { chapterId: chapter.id, confirmed: true, order: i },
    );
  const first = 'TEST 第一场景。' + '测试正文'.repeat(30),
    second = 'TEST 第二场景。' + '测试后续'.repeat(30),
    linked = first + '\n\nTEST 过渡。\n' + second;
  let call = 0;
  f.respond(async () => {
    call++;
    if (call === 1) return first;
    if (call === 2) throw new LLMError('bad_request', 'TEST interrupted second scene');
    return call === 3 ? second : linked;
  });
  await expect(writeScenesStep(f.ctx)).rejects.toThrow('TEST interrupted second scene');
  expect(await getDb().select('SELECT id FROM scene_drafts')).toHaveLength(1);
  expect((await getChapter(chapter.id))!.currentVersionId).toBeNull();
  const result = await writeScenesStep(f.ctx);
  expect(call).toBe(4);
  expect((await getVersion(result.outputRef!))!.content).toBe(linked);
  expect(f.requests[2]!.messages.at(-1)!.content).toContain(first);
  expect(f.requests[0]!.messages[0]!.content).toContain('参考约 250 中文字');
  expect(f.requests[0]!.messages[0]!.content).toContain('不重写此前场景');
  expect((await getChapter(chapter.id))!.committedVersionId).toBeNull();
  expect(await writeScenesStep(f.ctx)).toEqual(result);
  expect(call).toBe(4);
});


it('TEST mixed-genre preparation and trial-scene requirements reach the actual rolling planner', async () => {
  const f = await fixture('scene_plan', 1, ['urban', 'xianxia', 'mystery']);
  f.respond(async () => JSON.stringify({ chapters: [{ chapterId: f.chapters[0]!.id, scenes: [scene] }] }));
  await expect(scenePlanStep(f.ctx)).rejects.toThrow('章节页审阅并采纳');
  const system = f.requests[0]!.messages[0]!.content;
  expect(system).toContain('真实事件时间线');
  expect(system).toContain('具体职业任务');
  expect(system).toContain('关键能力表');
  expect(system).toContain('试写同一场景');
  expect(system).toContain('非本书事实');
  expect(system).toContain('作用于整部作品');
  expect(system).toContain('不得在每一章重复');
});
