import { testFirstReading } from '../helpers/writing';
import { testReadyLengthReview, testReadyStory } from '../helpers/writing';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { sseBody, sseResponse } from '../llm/helpers';
import { setSecretStore } from '@/secrets/keychain';
import { setFetchImpl } from '@/llm/registry';
import { createProvider } from '@/db/repos/providersRepo';
import { createNovel } from '@/db/repos/novelsRepo';
import { createVersion, getChapter, getVersion, listChapters, listVersions, saveSessionEdit, upsertChapterPlan } from '@/db/repos/chaptersRepo';
import { createSnapshot, replaceStorylineRows, upsertCharacter } from '@/db/repos/storylineRepo';
import { listCanonEvents } from '@/db/repos/writingRepo';
import { testScene } from '../helpers/writing';
import { saveBible, listBibleSnapshots } from '@/db/repos/bibleRepo';
import { createJob, getJob, listSteps, setJobStatus, setStepInput, stepReset, type Job } from '@/db/repos/jobsRepo';
import { emptyBible, emptyStoryline, emptyVoice } from '@the-water/shared';
import { defaultRequirements } from '@/novel/types';
import { planGenerate } from '@/jobs/planner';
import { kick, pauseJob, resumeJob } from '@/jobs/runner';
import type { FetchLike } from '@/llm/types';

const prose = (n: number) => Array.from({ length: n }, (_, i) => `第${i + 1}句，风从河面吹过来，带着水草的气味。`).join('');

/** OpenAI-compatible fake: JSON when response_format present, prose otherwise. */
function makeFetch(opts: { holdFirstProse?: { release: Promise<void> }; perspectiveId?: string } = {}): { fetch: FetchLike; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  let proseCalls = 0;
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push(body);
    const done = { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } };
    if (body.response_format) {
      const system = String((body.messages as Array<{role:string;content:string}>).find(m => m.role==='system')?.content);
      const event = { id:'TEST-event', kind:'event', entityId:null, threadId:null, text:'TEST 风吹过河面', ...(opts.perspectiveId ? {epistemic:'claim',perspectiveId:opts.perspectiveId} : {}), knownBy:[], time:'', location:'', dependencyIds:[], evidence:{startSpan:'s1',endSpan:'s1'} };
      const json = system.includes('第一次阅读作品') ? testFirstReading() : system.includes('叙事审稿人') ? {readerAlignment:[],issues:[],lengthReview:testReadyLengthReview(),story:testReadyStory()} : system.includes('设定校对') ? {numericConflicts:[],timelineConflicts:[],addressErrors:[],loreConflicts:[],verdict:'pass'} : { summary: 'TEST 老船夫章节摘要', events: [event, {...event,id:'TEST-fact',kind:'fact',text:'TEST 河面有风'}] };
      return sseResponse([sseBody([{ data: { choices: [{ delta: { content: JSON.stringify(json) } }] } }, { data: done }, { data: '[DONE]' }])]);
    }
    proseCalls++;
    const text = prose(12); // ~ 260 chars
    if (opts.holdFirstProse && proseCalls === 1) {
      const signal = init?.signal;
      const first = sseBody([{ data: { choices: [{ delta: { content: text.slice(0, 40) } }] } }]);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(first));
          const abort = () => controller.error(new DOMException('The operation was aborted.', 'AbortError'));
          if (signal?.aborted) abort();
          signal?.addEventListener('abort', abort);
          opts.holdFirstProse!.release.then(() => {
            try { controller.enqueue(new TextEncoder().encode(sseBody([{ data: { choices: [{ delta: { content: text.slice(40) } }] } }, { data: done }, { data: '[DONE]' }]))); controller.close(); } catch { /* errored */ }
          });
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return sseResponse([sseBody([{ data: { choices: [{ delta: { content: text.slice(0, 100) } }] } }, { data: { choices: [{ delta: { content: text.slice(100) } }] } }, { data: done }, { data: '[DONE]' }])]);
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

async function setupNovel(chapterCount: number) {
  await createProvider({ name: 'fake', kind: 'openai_compatible', baseUrl: 'https://fake.local/v1', model: 'fake', contextWindow: 32000, maxOutputTokens: 4000, jsonMode: 'json_object', temperature: 0.5, extraHeaders: {}, secretRef: 'env:FAKE_API_KEY' });
  const novel = await createNovel({ title: '河', premise: '一个少年沿河寻父', requirements: defaultRequirements(), targetChars: 250 * chapterCount, status: 'planning' });
  const doc = { ...emptyStoryline(), premise: novel.premise, characters: [{ id: 'c1', name: '阿水', aliases: [], role: '主角', description: '十六岁少年', arc: '', relationships: [], ...emptyVoice() }] };
  await replaceStorylineRows(novel.id, doc);
  for (let n = 1; n <= chapterCount; n++) await upsertChapterPlan(novel.id, { chapterNo: n, title: `第${n}章`, goal: '沿河前行', targetChars: 250, povCharacterId: 'c1' });
  await createSnapshot(novel.id, doc, 'generated');
  await saveBible(novel.id, 0, emptyBible());
  return novel;
}

beforeEach(() => {
  useTestDb();
  setSecretStore({ get: async () => 'k', set: async () => undefined, delete: async () => undefined });
});

describe('TEST job runner end-to-end (fake provider)', () => {
  it('TEST extraction includes a registered off-plan speaker and retains subjective attribution', async () => {
    const f=makeFetch({perspectiveId:'TEST-off-plan'});setFetchImpl(f.fetch);
    const novel=await setupNovel(1),chapters=await listChapters(novel.id);
    await testScene(novel.id,chapters[0]!.id,'c1');
    await upsertCharacter(novel.id,{id:'TEST-off-plan',name:'TEST 临时出现的证人',description:'TEST fixture identity, not real generation'});
    const job=await createJob({novelId:novel.id,type:'generate_novel',params:{},providerId:null,steps:planGenerate(chapters,{fiction:false})});
    kick();await waitFor(async()=>terminal(await getJob(job.id)));
    expect((await getJob(job.id))!.status).toBe('completed');
    const request=f.calls.find(b=>(b.messages as {content:string}[]).some(m=>m.content.includes('你是正文事实记录员'))) !;
    expect(JSON.stringify(request.messages)).toContain('TEST-off-plan');
    expect(JSON.stringify(request.messages)).toContain('TEST 临时出现的证人');
    const events=await listCanonEvents(novel.id,2);
    expect(events.length).toBeGreaterThan(0);
    for(const e of events){expect(e.epistemic).toBe('claim');expect(e.perspectiveId).toBe('TEST-off-plan');}
  });
  it('TEST resumes a paused review against the author revision without a second continue', async () => {
    const f = makeFetch(); setFetchImpl(f.fetch);
    const novel = await setupNovel(1), chapter = (await listChapters(novel.id))[0]!;
    const old = await createVersion({chapterId:chapter.id,content:prose(12),source:'generated'});
    const job = await createJob({novelId:novel.id,type:'generate_novel',params:{},providerId:null,steps:[{kind:'style_check',chapterId:chapter.id,input:{}}]});
    const step = (await listSteps(job.id))[0]!;
    await setStepInput(step.id,{dependencyHash:'TEST old dependency',candidateVersionId:old.id,candidateHash:old.contentHash});
    await setJobStatus(job.id,'paused');
    const revision = await saveSessionEdit({chapterId:chapter.id,sessionId:'TEST paused author edit',content:prose(12)+'TEST 作者修订。'});
    await resumeJob(job.id);
    await waitFor(async()=>terminal(await getJob(job.id)));
    expect((await getJob(job.id))!.status).toBe('completed');
    expect((await listSteps(job.id))[0]!.input.candidateVersionId).toBe(revision.id);
    expect(f.calls.some(call=>JSON.stringify(call.messages).includes('TEST 作者修订。'))).toBe(true);
    expect((await getChapter(chapter.id))!.committedVersionId).toBeNull();
  });
  it('TEST an in-flight generation cannot overwrite edits within the same draft session',async()=>{
    let release!:()=>void;const hold=new Promise<void>(r=>{release=r;});
    const f=makeFetch({holdFirstProse:{release:hold}});setFetchImpl(f.fetch);
    const novel=await setupNovel(1),chapter=(await listChapters(novel.id))[0]!;
    const draft=await saveSessionEdit({chapterId:chapter.id,sessionId:'TEST concurrent editor',content:'TEST before generation'});
    const job=await createJob({novelId:novel.id,type:'generate_novel',params:{},providerId:null,steps:planGenerate(await listChapters(novel.id),{fiction:false,force:true})});
    kick();await waitFor(async()=>f.calls.length>0);
    const edit=await saveSessionEdit({chapterId:chapter.id,sessionId:'TEST concurrent editor',content:'TEST author continues typing',expectedHash:draft.contentHash});
    release();await waitFor(async()=>(await getJob(job.id))?.status==='awaiting_review');
    expect((await getChapter(chapter.id))!.currentVersionId).toBe(edit.id);
    expect((await getVersion(edit.id))!.content).toBe('TEST author continues typing');
    expect((await getChapter(chapter.id))!.committedVersionId).toBeNull();
  });
  it('writes all chapters, summarizes, updates bible and completes', async () => {
    const f = makeFetch();
    setFetchImpl(f.fetch);
    const novel = await setupNovel(2);
    const chapters = await listChapters(novel.id);
    const job = await createJob({ novelId: novel.id, type: 'generate_novel', params: {}, providerId: null, steps: planGenerate(chapters, { fiction: false }) });
    await setJobStatus(job.id, 'running');
    kick();
    await waitFor(async () => terminal(await getJob(job.id)));
    const j = (await getJob(job.id))!;
    expect(j.status).toBe('completed');
    expect(j.progress.done).toBe(10);
    const after = await listChapters(novel.id);
    for (const c of after) {
      expect(c.currentVersionId).not.toBeNull();
      const versions = await listVersions(c.id);
      expect(versions[0]!.source).toBe('generated');
      expect(versions[0]!.summary).toContain('老船夫');
      expect(versions[0]!.charCount).toBeGreaterThan(200);
    }
    const bibles = await listBibleSnapshots(novel.id);
    expect(bibles.map((b) => b.afterChapterNo)).toEqual([0, 1, 2]);
    expect(bibles[2]!.bible.timeline).toHaveLength(2);
    expect(bibles[2]!.bible.facts).toContain('TEST 河面有风');
    // second chapter prompt saw the first chapter's summary
    const secondWrite = f.calls.filter((b) => !b.response_format)[1]!;
    const user = (secondWrite.messages as Array<{ role: string; content: string }>).find((m) => m.role === 'user')!.content;
    expect(user).toContain('老船夫');
  });

  it('is idempotent after a crash between version write and step completion', async () => {
    setFetchImpl(makeFetch().fetch);
    const novel = await setupNovel(1);
    const chapters = await listChapters(novel.id);
    const job = await createJob({ novelId: novel.id, type: 'generate_novel', params: {}, providerId: null, steps: planGenerate(chapters, { fiction: false }) });
    const steps = await listSteps(job.id);
    // simulate: write_chapter produced a version but the app died before stepDone
    await createVersion({ chapterId: chapters[0]!.id, content: prose(12), source: 'generated', jobStepId: steps[0]!.id });
    await stepReset(steps[0]!.id);
    await setJobStatus(job.id, 'running');
    kick();
    await waitFor(async () => terminal(await getJob(job.id)));
    expect((await getJob(job.id))!.status).toBe('completed');
    const versions = await listVersions(chapters[0]!.id);
    expect(versions.filter((v) => v.source === 'generated')).toHaveLength(1);
  });

  it('pauses mid-stream (step back to pending, partial kept) and resumes to completion', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    setFetchImpl(makeFetch({ holdFirstProse: { release: held } }).fetch);
    const novel = await setupNovel(1);
    const chapters = await listChapters(novel.id);
    const job = await createJob({ novelId: novel.id, type: 'generate_novel', params: {}, providerId: null, steps: planGenerate(chapters, { fiction: false }) });
    await setJobStatus(job.id, 'running');
    kick();
    await waitFor(async () => (await listSteps(job.id))[0]!.status === 'running');
    await new Promise((r) => setTimeout(r, 50));
    await pauseJob(job.id);
    await waitFor(async () => (await getJob(job.id))!.status === 'paused');
    const s = (await listSteps(job.id))[0]!;
    expect(s.status).toBe('pending');
    expect(s.partialText ?? '').toContain('第1句');
    expect(await listVersions(chapters[0]!.id)).toHaveLength(0);
    expect((await getChapter(chapters[0]!.id))!.currentVersionId).toBeNull();
    release();
    await resumeJob(job.id);
    await waitFor(async () => (await getJob(job.id))!.status === 'completed');
    expect(await listVersions(chapters[0]!.id)).toHaveLength(1);
  });
});
