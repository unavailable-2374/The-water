import { testFirstReading } from '../helpers/writing';
/** TEST / SIMULATED provider responses. These tests verify orchestration, not literary quality. */
import { simulatedOutlineReview } from '../helpers/outlineReview';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { testReadyLengthReview, testReadyStory } from '../helpers/writing';
import { sseBody, sseResponse } from '../llm/helpers';
import { createProvider } from '@/db/repos/providersRepo';
import { setSecretStore } from '@/secrets/keychain';
import { setFetchImpl } from '@/llm/registry';
import { getDb } from '@/db/db';
import { createNovel } from '@/db/repos/novelsRepo';
import { listChapters, upsertChapterPlan } from '@/db/repos/chaptersRepo';
import { waitForJobRunnerIdle } from '@/jobs/runner';
import { listJobs } from '@/db/repos/jobsRepo';
import { createConversation, appendMessage } from '@/db/repos/conversationsRepo';
import { defaultRequirements } from '@/novel/types';
import { AssistantContextSchema, emptyVoice } from '@the-water/shared';
import { upsertCharacter } from '@/db/repos/storylineRepo';
import { listCanonEvents } from '@/db/repos/writingRepo';
import {
  startAssistantRuntime,
  sendAssistant,
  useAssistant,
  pauseAssistant,
  undoAssistantChanges,
} from '@/assistant/runtime';
import { getRun, listOperations } from '@/assistant/repository';

let db: ReturnType<typeof useTestDb>;
const scripted: Array<unknown> = [];
const calls: string[] = [];
const prose =
  'TEST / SIMULATED。' +
  Array.from(
    { length: 12 },
    (_, i) => `第${i + 1}句，林舟把信封放在桌上，决定先核对邮戳日期，然后才把登记簿交还给顾青。`,
  ).join('');
const reply = (content: unknown) =>
  sseResponse([
    sseBody([
      {
        data: {
          choices: [
            {
              delta: { content: typeof content === 'string' ? content : JSON.stringify(content) },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 20 },
        },
      },
      { data: '[DONE]' },
    ]),
  ]);
async function settle(id: string) {
  for (let n = 0; n < 1500; n++) {
    const r = await getRun(id);
    if (r && !['running', 'waiting_job'].includes(r.state)) return r;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('TEST orchestration timeout');
}
beforeEach(async () => {
  db = useTestDb();
  scripted.length = 0;
  calls.length = 0;
  useAssistant.setState({ context: AssistantContextSchema.parse({}) });
  setSecretStore({
    get: async () => 'TEST fake credential',
    set: async () => {},
    delete: async () => {},
  });
  await createProvider({
    name: 'TEST SIMULATED',
    kind: 'openai_compatible',
    baseUrl: 'https://test.invalid/v1',
    model: 'TEST',
    contextWindow: 1048576,
    maxOutputTokens: 20000,
    jsonMode: 'json_object',
    temperature: 0.2,
    extraHeaders: {},
    secretRef: 'TEST',
  });
  setFetchImpl(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const system = String(
      body.messages.find((m: { role: string }) => m.role === 'system')?.content ?? '',
    );
    calls.push(system);
    if (system.includes('你是独立审查大纲的编辑')) return reply(simulatedOutlineReview());
    if (system.includes('unified writing assistant')) {
      const decision = scripted.shift();
      if (!decision) throw new Error('TEST missing scripted assistant response');
      return reply(decision);
    }
    if (system.includes('发展成结构完整'))
      return reply({
        title: 'TEST work',
        logline: 'TEST 核对日期',
        themes: [],
        characters: [],
        settings: [],
        arcs: [
          {
            title: 'TEST 核对',
            summary: 'TEST 核对后归还信封',
            startChapterNo: 1,
            endChapterNo: 1,
          },
        ],
        beats: [],
        writing: {
          brief: {
            premise: 'TEST',
            mainline: 'TEST',
            ending: 'TEST 归还',
            audience: 'TEST',
            constraints: [],
            rollingChapters: 1,
            readingExperience: 'TEST',
            distinctiveApproach: 'TEST',
            protagonistLimits: 'TEST',
            firstChoice: 'TEST',
            choiceConsequences: 'TEST',
            storyEngine: 'TEST',
            endingConditions: 'TEST',
          },
          volumes: [],
          intents: [],
          threads: [],
        },
      });
    if (
      system.includes('章节规划') ||
      body.messages.some((m: { content: string }) => m.content.includes('请为第 1–1 章生成章节表'))
    )
      return reply({
        chapters: [
          {
            chapterNo: 1,
            title: 'TEST 日期',
            goal: 'TEST 核对',
            beatTitles: [],
            povCharacter: null,
            targetChars: 500,
            endHook: 'TEST 归还',
          },
        ],
      });
    if (system.includes('最多五章')) {
      const n = (await getDb().select<{ id: string }>('SELECT id FROM novels'))[0]!.id;
      const c = (await listChapters(n))[0]!;
      return reply({
        chapters: [
          {
            chapterId: c.id,
            scenes: [
              {
                title: 'TEST 场景',
                volumeId: null,
                povCharacterId: null,
                time: 'TEST',
                location: 'TEST',
                characterIds: [],
                goal: 'TEST',
                obstacle: 'TEST',
                turn: 'TEST',
                outcome: 'TEST',
                targetChars: 500,
                dependencyIds: [],
                threadIds: [],
                readerInterest: 'TEST',
                choice: 'TEST',
                choiceReason: 'TEST',
                consequence: 'TEST',
                beforeState: 'TEST',
                afterState: 'TEST',
                presentation: 'dramatize',
              },
            ],
          },
        ],
      });
    }
    if(system.includes('第一次阅读作品')) return reply(testFirstReading());
    if (system.includes('叙事审稿人'))
      return reply({ readerAlignment:[], issues: [], lengthReview: testReadyLengthReview(), story: testReadyStory() });
    if (system.includes('设定校对'))
      return reply({
        numericConflicts: [],
        timelineConflicts: [],
        addressErrors: [],
        loreConflicts: [],
        verdict: 'pass',
      });
    if (body.response_format)
      return reply({
        summary: 'TEST SIMULATED summary',
        events: [
          {
            id: 'TEST-event',
            kind: 'event',
            entityId: null,
            threadId: null,
            text: 'TEST 林舟核对邮戳后交还登记簿',
            knownBy: [],
            time: '',
            location: '',
            dependencyIds: [],
            // TEST / SIMULATED selection; the application computes source bytes and offsets.
            evidence: { startSpan: 's1', endSpan: 's1' },
          },
        ],
      });
    return reply(prose);
  });
  await startAssistantRuntime();
});
afterEach(async () => {
  for (const job of await listJobs())
    if (typeof job.params.assistantRunId === 'string')
      await pauseAssistant(job.params.assistantRunId, true);
  await waitForJobRunnerIdle();
  db.raw.close();
});
it('TEST discussion never mutates works or replays legacy history', async () => {
  const old = await createConversation({ kind: 'scratch', title: 'TEST old' });
  await appendMessage({
    conversationId: old.id,
    role: 'user',
    content: 'TEST old command must not replay',
  });
  scripted.push({ kind: 'answer', text: 'TEST discussion only' });
  const r = await sendAssistant('TEST discuss ideas');
  expect((await settle(r.id)).state).toBe('completed');
  expect(await getDb().select('SELECT id FROM novels')).toEqual([]);
  expect(await listOperations(r.id)).toEqual([]);
});
it('TEST complete dialogue pipeline creates, plans, writes, independently reviews and commits', async () => {
  scripted.push(
    {
      kind: 'operate',
      intent: 'explicit_edit',
      summary: 'TEST create',
      operation: {
        name: 'create_work',
        parameters: {
          title: 'TEST work',
          premise: 'TEST 核对日期后归还信封',
          targetChars: 500,
          requirements: { docType: 'short-story' },
        },
      },
    },
    {
      kind: 'operate',
      intent: 'authorized_continuation',
      summary: 'TEST finish',
      operation: {
        name: 'finish_work',
        parameters: {
          goal: 'TEST complete work',
          constraints: ['TEST never skip independent review'],
        },
      },
    },
  );
  const r = await sendAssistant('TEST 新建并写完整部作品');
  const done = await settle(r.id);
  expect({ state: done.state, error: done.error }).toEqual({ state: 'completed', error: null });
  const chapters = await listChapters(done.novelId!);
  expect(chapters.length).toBeGreaterThan(0);
  expect(
    chapters.every(
      (c) => c.memoryStatus === 'valid' && c.committedVersionId === c.currentVersionId,
    ),
  ).toBe(true);
  const facts = await listCanonEvents(done.novelId!, 501);
  expect(facts.length).toBeGreaterThan(0);
  expect(facts[0]!.evidence.to).toBeGreaterThan(facts[0]!.evidence.from);
  expect(prose.slice(facts[0]!.evidence.from, facts[0]!.evidence.to)).toBe(
    facts[0]!.evidence.quote,
  );
  const proposals = await getDb().select<{ assistant_run_id: string; state: string }>(
    'SELECT assistant_run_id,state FROM writing_proposals',
  );
  expect(proposals.length).toBeGreaterThan(0);
  expect(proposals.every((p) => p.assistant_run_id === r.id && p.state === 'accepted')).toBe(true);
  expect(calls.some((s) => s.includes('叙事审稿人'))).toBe(true);
  expect(
    await getDb().select("SELECT id FROM usage_events WHERE purpose='planning'"),
  ).not.toHaveLength(0);
  const replay = await sendAssistant(
    'TEST 新建并写完整部作品',
    AssistantContextSchema.parse({}),
    r.id,
  );
  expect(replay.state).toBe('completed');
  expect(await getDb().select('SELECT id FROM novels')).toHaveLength(1);
  await undoAssistantChanges(r.id);
  expect((await getRun(r.id))?.state).toBe('undone');
  expect(
    (await getDb().select<{ deleted_at: number }>('SELECT deleted_at FROM novels'))[0]?.deleted_at,
  ).toBeGreaterThan(0);
});
it('TEST duplicate names require clarification before the selected model action can write', async () => {
  const n = await createNovel({
    title: 'TEST duplicates',
    premise: 'TEST',
    requirements: defaultRequirements(),
    targetChars: 300,
  });
  const character = {
    name: 'TEST 林',
    aliases: [],
    role: 'TEST',
    description: 'TEST',
    arc: '',
    relationships: [],
    ...emptyVoice(),
  };
  await upsertCharacter(n.id, { ...character, id: 'TEST-one' });
  await upsertCharacter(n.id, { ...character, id: 'TEST-two' });
  scripted.push({
    kind: 'operate',
    intent: 'explicit_edit',
    summary: 'TEST',
    operation: {
      name: 'character',
      parameters: { value: { ...character, id: 'TEST-one', description: 'TEST change' } },
    },
  });
  const r = await sendAssistant('修改 TEST 林', AssistantContextSchema.parse({ novelId: n.id }));
  expect((await settle(r.id)).state).toBe('needs_input');
  expect(await listOperations(r.id)).toEqual([]);
});
it('TEST restart pauses active assistant runs and preserves source messages', async () => {
  const n = await createNovel({
    title: 'TEST recovery',
    premise: 'TEST',
    requirements: defaultRequirements(),
    targetChars: 300,
  });
  await upsertChapterPlan(n.id, { chapterNo: 1 });
  const { createRun, sessionFor } = await import('@/assistant/repository');
  const context = AssistantContextSchema.parse({ novelId: n.id });
  const r = await createRun(
    'TEST-interrupted',
    await sessionFor(context),
    context,
    'TEST durable intent',
  );
  await startAssistantRuntime();
  expect((await getRun(r.id))?.state).toBe('paused');
  expect(await getDb().select('SELECT id FROM ai_messages WHERE id=?', [r.messageId])).toHaveLength(
    1,
  );
});

it('TEST an authentication failure records unknown planning usage and never reports success', async () => {
  setFetchImpl(
    async () =>
      new Response(JSON.stringify({ error: { message: 'TEST SIMULATED rejected key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const run = await sendAssistant('TEST failed call');
  expect((await settle(run.id)).state).toBe('failed');
  expect(await listOperations(run.id)).toEqual([]);
  const usage = await getDb().select<{ purpose: string; price_id: string | null }>(
    'SELECT purpose,price_id FROM usage_events',
  );
  expect(usage).toEqual([{ purpose: 'planning', price_id: null }]);
});

it('TEST duplicate model decisions receive repair feedback without a second mutation', async () => {
  const n = await createNovel({
    title: 'TEST original',
    premise: 'TEST',
    requirements: defaultRequirements(),
    targetChars: 300,
  });
  const change = {
    kind: 'operate',
    intent: 'explicit_edit',
    summary: 'TEST change',
    operation: { name: 'edit_work', parameters: { title: 'TEST changed' } },
  };
  scripted.push(change, change, { kind: 'answer', text: 'TEST actual change completed' });
  const run = await sendAssistant(
    'TEST change title',
    AssistantContextSchema.parse({ novelId: n.id }),
  );
  expect((await settle(run.id)).state).toBe('completed');
  expect(await listOperations(run.id)).toHaveLength(1);
});

async function completedTestWork() {
  scripted.push(
    {
      kind: 'operate',
      intent: 'explicit_edit',
      summary: 'TEST create',
      operation: {
        name: 'create_work',
        parameters: {
          title: 'TEST completion gate',
          premise: 'TEST 核对日期',
          targetChars: 500,
          requirements: { docType: 'short-story' },
        },
      },
    },
    {
      kind: 'operate',
      intent: 'authorized_continuation',
      summary: 'TEST finish',
      operation: {
        name: 'finish_work',
        parameters: { goal: 'TEST complete fiction', constraints: [] },
      },
    },
  );
  const run = await settle((await sendAssistant('TEST 新建并完成作品')).id);
  expect(run.state).toBe('completed');
  const chapters = await listChapters(run.novelId!);
  return { novelId: run.novelId!, chapterId: chapters[0]!.id };
}

it('TEST a final background operation persists completion and stops without another model decision', async () => {
  const { novelId, chapterId } = await completedTestWork();
  scripted.push({
    kind: 'operate',
    intent: 'explicit_edit',
    summary: 'TEST final review',
    completeAfterOperation: true,
    operation: { name: 'review', parameters: { chapterIds: [chapterId] } },
  });
  const run = await settle(
    (await sendAssistant('TEST 重新审查并提交', AssistantContextSchema.parse({ novelId }))).id,
  );
  expect({ state: run.state, error: run.error }).toEqual({ state: 'completed', error: null });
  expect((await listOperations(run.id))[0]?.completeAfter).toBe(true);
  expect((await listChapters(novelId))[0]?.memoryStatus).toBe('valid');
});

it('TEST planning edits after a promised commit trigger fresh review before reporting completion', async () => {
  const { novelId, chapterId } = await completedTestWork();
  scripted.push(
    {
      kind: 'operate',
      intent: 'explicit_edit',
      summary: 'TEST review',
      operation: { name: 'review', parameters: { chapterIds: [chapterId] } },
    },
    {
      kind: 'operate',
      intent: 'authorized_continuation',
      summary: 'TEST late planning edit',
      completeAfterOperation: true,
      operation: { name: 'author_note', parameters: { value: 'TEST 保留核对邮戳的因果链' } },
    },
  );
  const run = await settle(
    (await sendAssistant('TEST 补充指令并审查提交', AssistantContextSchema.parse({ novelId }))).id,
  );
  expect({ state: run.state, error: run.error }).toEqual({ state: 'completed', error: null });
  expect((await listOperations(run.id)).map((op) => op.name)).toEqual([
    'review',
    'author_note',
    'review',
  ]);
  const chapter = (await listChapters(novelId))[0]!;
  expect(chapter.memoryStatus).toBe('valid');
  expect(chapter.currentVersionId).toBe(chapter.committedVersionId);
});
