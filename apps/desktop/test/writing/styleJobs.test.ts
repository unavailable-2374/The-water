import { testReadyLengthReview, testReadyStory } from '../helpers/writing';
import { listDocumentPlans, acceptDocumentPlan } from '@/db/repos/planProposalsRepo';
import { resumeJob } from '@/jobs/runner';
// TEST: scripted provider fixtures; not evidence of real writing quality.
import { testScene } from '../helpers/writing';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { getDb } from '@/db/db';
import { sseBody, sseResponse } from '../llm/helpers';
import { setSecretStore } from '@/secrets/keychain';
import { setFetchImpl } from '@/llm/registry';
import { createProvider } from '@/db/repos/providersRepo';
import { createNovel } from '@/db/repos/novelsRepo';
import { createVersion, getChapter, listChapters, listVersions, upsertChapterPlan } from '@/db/repos/chaptersRepo';
import { createSnapshot, getStyleExtras, listCharacters, listSettings, replaceStorylineRows } from '@/db/repos/storylineRepo';
import { saveBible } from '@/db/repos/bibleRepo';
import { getJob, listSteps, type Job } from '@/db/repos/jobsRepo';
import { latestReviewForChapter } from '@/db/repos/reviewsRepo';
import { countZh, emptyBible, emptyDerivative, emptyStoryline, emptyStyleProfile, emptyVoice } from '@the-water/shared';
import { defaultRequirements } from '@/novel/types';
import { startGeneration, startStyleCheck, startStyleExtraction, wantsStyleCheck } from '@/novel/service';
import { sampleChapterNos } from '@/jobs/steps/extractStyleStep';
import { saveStyleCheckConfig } from '@/novel/config';
import { clearAuthorNoteCache, saveAuthorNote } from '@/llm/prompts/authorNote';
import type { FetchLike } from '@/llm/types';

const terse = (n: number) => 'TEST 我错了。他一步跨入元婴。\n\n' + Array.from({ length: n }, (_, i) => (i % 3 === 0 ? `刀出。人退。灯灭了。\n\n“你来了。”\n\n“来了。”` : `他没有答话，把刀鞘往桌上一搁。风从檐角过，带着铁锈味。`)).join('\n\n');
const flowery = (n: number) => Array.from({ length: n }, () => '他的心中涌起一股难以言喻的悲伤，仿佛整个世界都在这一刻崩塌了，而他却无能为力地站在那里看着一切慢慢消逝！').join('');

/** Fake provider: routes by prompt content. */
function makeFetch(opts: { reviewVerdict?: 'pass' | 'revise'; consistency?: 'pass' | 'revise'; prose?: () => string; clearAfterRevision?: boolean; story?: 'revise'|'replan'|'opinion'; lengthAction?: 'expand'|'trim' } = {}) {
  const calls: Array<{ kind: string; user: string; system: string }> = [];
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }>; response_format?: unknown };
    const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
    const system = body.messages.find((m) => m.role === 'system')?.content ?? '';
    const done = { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } };
    const reply = (text: string) => sseResponse([sseBody([{ data: { choices: [{ delta: { content: text } }] } }, { data: done }, { data: '[DONE]' }])]);
    if (body.response_format) {
      if(system.includes('局部修订编辑')) {calls.push({kind:'revise',user,system});return reply(JSON.stringify({patches:[opts.consistency==='revise' ? {from:9,to:16,original:'他一步跨入元婴',replacement:'他仍停在炼气三层'} : {from:5,to:8,original:'我错了',replacement:opts.clearAfterRevision || opts.story==='revise' ? '他按住刀鞘':'我错了'}]}));}
      if (system.includes('叙事审稿')) { calls.push({ kind: 'narrative', user, system }); const unresolved=opts.story==='revise' && !calls.some(c=>c.kind==='revise');
        return reply(JSON.stringify({issues:unresolved || opts.story==='opinion' ? [{id:'TEST-story-issue',category:unresolved ? opts.lengthAction==='trim' ? 'repetition' : 'motivation' : 'style',severity:'suggestion',evidence:{quote:'我错了'},basis:'TEST / SIMULATED editorial diagnosis',suggestion:'TEST 补足当前选择而不改变主线',sourceIds:[]}] : [],lengthReview:opts.lengthAction && (unresolved || opts.story==='opinion') ? {action:opts.lengthAction,reason:'TEST / SIMULATED scene completeness diagnosis, independent of word count',actions:[{action:opts.lengthAction,issueId:'TEST-story-issue'}]} : testReadyLengthReview(),story:{...testReadyStory(),verdict:opts.story==='replan'?'replan':unresolved?'revise':'ready'}})); }
      if (user.includes('请提炼这部作品的文风档案')) {
        calls.push({ kind: 'extract', user, system });
        return reply(JSON.stringify({
          voice: { narrator: '克制的第三人称', rhythm: '短句连击', imagery: '刀、灯、风', dialogue: '极短，用道', humor: '冷', emotion: '藏在动作里', genreConventions: '打斗只写三招' },
          evidence: { rhythm: ['刀出。人退。'] },
          signatureMoves: [{ move: '章末短评', example: '灯灭了。', perChapter: 1 }],
          exemplars: [{ sceneType: 'fight', text: '刀出。人退。灯灭了。'.repeat(6), illustrates: ['rhythm'] }],
          humanReadableConstraints: ['动作段用 5–10 字短句', '对白用道不用说'],
          avoidWords: ['OK'], avoidPatterns: ['眼底闪过一丝'],
          characters: [{ name: '阿水', speechSamples: ['你来了。', '不喝。'], verbalTics: ['罢了'], addressBook: { 自称: '在下' }, redlines: ['不解释动机'] }],
          lore: [{ name: '递刀礼', kind: 'rule', triggerKeys: ['递刀'], content: '递刀即托付性命' }],
        }));
      }
      if (user.includes('请审校这一章')) {
        calls.push({ kind: 'review', user, system });
        const verdict = opts.clearAfterRevision && calls.some(c => c.kind === 'revise') ? 'pass' : opts.reviewVerdict ?? 'pass';
        return reply(JSON.stringify({
          styleScore: verdict === 'pass' ? 92 : 40,
          dimensionScores: { narrator: 90, rhythm: 90, imagery: 90, dialogue: 90, humor: 90, emotion: 90 },
          driftFindings: verdict === 'pass' ? [] : [{ quote: '难以言喻的悲伤', dimension: 'emotion', why: '直接写情绪', suggest: '用动作' }],
          ooc: verdict === 'pass' ? [] : [{ character: '阿水', quote: '我错了', verdict: 'OOC', redline: '不解释动机', why: '' }],
          canonConflicts: [], aiTells: [], verdict,
        }));
      }
      if (user.includes('请只做设定校对')) {
        calls.push({ kind: 'consistency', user, system });
        const bad = opts.consistency === 'revise' && !(opts.clearAfterRevision && calls.some(c => c.kind === 'revise'));
        return reply(JSON.stringify({
          numericConflicts: bad ? [{ quote: '他一步跨入元婴', against: '境界体系', why: '上一章还是炼气三层' }] : [],
          timelineConflicts: [], addressErrors: [], loreConflicts: [],
          verdict: bad ? 'revise' : 'pass',
        }));
      }
      calls.push({ kind: 'summarize', user, system });
      return reply(JSON.stringify({ summary: 'TEST 主角沿河前行。', events: [] }));
    }
    calls.push({ kind: system.includes('改写方式') ? 'revise' : 'write', user, system });
    return reply(opts.prose ? opts.prose() : terse(14));
  };
  return { fetch, calls };
}

async function waitFor(pred: () => Promise<boolean>, ms = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (await pred()) return; await new Promise((r) => setTimeout(r, 15)); }
  throw new Error('timeout');
}
const terminal = (j: Job | null) => !!j && ['completed', 'failed', 'cancelled', 'paused', 'awaiting_review'].includes(j.status);
const status = async (id: string) => { const j = (await getJob(id))!; return `${j.status} ${j.error ?? ''} ${(await listSteps(id)).map((s) => `${s.kind}:${s.status}:${s.error ?? ''}`).join(' | ')}`; };

async function setupNovel(chapterCount: number, opts: { withProfile?: boolean; derivative?: boolean; requirements?: Partial<ReturnType<typeof defaultRequirements>>; facts?: string[] } = {}) {
  await createProvider({ name: 'fake', kind: 'openai_compatible', baseUrl: 'https://fake.local/v1', model: 'fake', contextWindow: 32000, maxOutputTokens: 4000, jsonMode: 'json_object', temperature: 0.5, extraHeaders: {}, secretRef: 'env:FAKE_API_KEY' });
  const novel = await createNovel({ title: '河', premise: '一个少年沿河寻父', requirements: { ...defaultRequirements(), ...opts.requirements }, targetChars: countZh(terse(14)) * chapterCount, status: 'planning' });
  const doc = {
    ...emptyStoryline(), premise: novel.premise,
    characters: [{ id: 'c1', name: '阿水', aliases: [], role: '主角', description: '十六岁少年', arc: '', relationships: [], ...emptyVoice() }],
    settings: (opts.facts ?? []).map((description,i) => ({ id: `TEST-rule-${i}`, name: description, kind:'rule' as const, description, triggerKeys:[], priority:100, constant:true })),
    styleProfile: opts.withProfile ? { ...emptyStyleProfile({ id: 'sp', name: '江湖' }), injection: { summaryBudget: 300, exemplarCount: 3, humanReadableConstraints: ['短句'] } } : null,
    derivative: opts.derivative ? { ...emptyDerivative(), styleFidelity: 0.8 } : null,
  };
  await replaceStorylineRows(novel.id, doc);
  for (let n = 1; n <= chapterCount; n++) await upsertChapterPlan(novel.id, { chapterNo: n, title: `第${n}章`, goal: '沿河前行', targetChars: countZh(terse(14)), povCharacterId: 'c1' });
  for (const c of await listChapters(novel.id)) await testScene(novel.id, c.id);
  await createSnapshot(novel.id, doc, 'generated');
  await saveBible(novel.id, 0, { ...emptyBible(), facts: opts.facts ?? [] });
  return novel;
}

beforeEach(() => {
  useTestDb();
  clearAuthorNoteCache();
  setSecretStore({ get: async () => 'k', set: async () => undefined, delete: async () => undefined });
});

describe('sampleChapterNos', () => {
  it('keeps the first three and spreads the rest', () => {
    expect(sampleChapterNos(5)).toEqual([1, 2, 3, 4, 5]);
    const s = sampleChapterNos(40, 8);
    expect(s.slice(0, 3)).toEqual([1, 2, 3]);
    expect(s).toHaveLength(8);
    expect(s.at(-1)).toBeLessThanOrEqual(40);
  });
});

describe('extract_style job', () => {
  it('computes metrics, merges the LLM extract, fills character voice and adds lore settings', async () => {
    const f = makeFetch();
    setFetchImpl(f.fetch);
    const novel = await setupNovel(3);
    for (const c of await listChapters(novel.id)) await createVersion({ chapterId: c.id, content: terse(30), source: 'imported', status: 'final' });
    expect(await wantsStyleCheck(novel.id)).toBe(true);
    const jobId = await startStyleExtraction(novel.id);
    await waitFor(async () => terminal(await getJob(jobId)));
    expect((await getJob(jobId))!.status).toBe('awaiting_review');
    expect((await listCharacters(novel.id))[0]!.redlines).toEqual([]);
    const [proposal] = await listDocumentPlans(novel.id);
    await acceptDocumentPlan(novel.id, proposal!.id);
    await resumeJob(jobId);
    await waitFor(async()=>terminal(await getJob(jobId)));
    expect(await status(jobId)).toMatch(/^completed/);
    expect(f.calls.filter((c) => c.kind === 'extract')).toHaveLength(1);
    expect(f.calls[0]!.user).toContain('本地统计参考');
    const { styleProfile } = await getStyleExtras(novel.id);
    expect(styleProfile!.source.kind).toBe('extracted');
    expect(styleProfile!.metrics!.sampledChars).toBeGreaterThan(100);
    expect(styleProfile!.targets.sentenceMean).not.toBeNull();
    expect(styleProfile!.voice.rhythm.text).toBe('短句连击');
    expect(styleProfile!.exemplars).toHaveLength(1);
    expect(styleProfile!.injection.humanReadableConstraints).toEqual(['动作段用 5–10 字短句', '对白用道不用说']);
    const [c] = await listCharacters(novel.id);
    expect(c!.speechSamples).toEqual(['你来了。', '不喝。']);
    expect(c!.redlines).toEqual(['不解释动机']);
    const lore = (await listSettings(novel.id)).find((s) => s.name === '递刀礼');
    expect(lore).toMatchObject({ kind: 'rule', triggerKeys: ['递刀'], priority: 70 });
    expect(await wantsStyleCheck(novel.id)).toBe(true);
  });
});

describe('generation with style_check', () => {
  it('injects the style summary + exemplars into the writing prompt and records a passing review', async () => {
    const f = makeFetch();
    setFetchImpl(f.fetch);
    const novel = await setupNovel(1, { withProfile: true });
    const jobId = await startGeneration(novel.id);
    await waitFor(async () => terminal(await getJob(jobId)));
    expect((await getJob(jobId))!.status).toBe('completed');
    expect((await listSteps(jobId)).map((s) => s.kind)).toEqual(['scene_plan', 'write_scenes', 'adjust_length', 'style_check', 'summarize', 'commit_chapter']);
    const write = f.calls.find((c) => c.kind === 'write')!;
    expect(write.system).toContain('【文风：江湖】');
    expect(write.system).toContain('- 短句');
    expect(f.calls.some((c) => c.kind === 'review')).toBe(true);
    const ch = (await listChapters(novel.id))[0]!;
    const review = (await latestReviewForChapter(ch.id))!;
    expect(review.verdict).toBe('pass');
    expect(review.styleScore).toBeGreaterThan(80);
    expect(review.report.llm!.styleScore).toBe(92);
    expect(await listVersions(ch.id)).toHaveLength(1);
  });
  it('revises once with targeted instructions when the review says revise, then re-assesses', async () => {
    const f = makeFetch({ reviewVerdict: 'revise', clearAfterRevision: true });
    setFetchImpl(f.fetch);
    const novel = await setupNovel(1, { withProfile: true, derivative: true });
    const jobId = await startGeneration(novel.id);
    await waitFor(async () => terminal(await getJob(jobId)));
    expect((await getJob(jobId))!.status).toBe('completed');
    const revise = f.calls.find((c) => c.kind === 'revise')!;
    expect(revise.system).toContain('局部修订');
    expect(revise.system).toContain('【二创声明】');
    expect(revise.user).toContain('不解释动机');
    expect(revise.user).toContain('我错了');
    expect(revise.user).not.toContain('不像原著');
    expect(f.calls.filter((c) => c.kind === 'review')).toHaveLength(2);
    const ch = (await listChapters(novel.id))[0]!;
    const versions = await listVersions(ch.id);
    expect(versions.map((v) => v.source)).toEqual(['rewritten', 'generated']);
    const review = (await latestReviewForChapter(ch.id))!;
    expect(review.chapterVersionId).toBe(versions[0]!.id);
    expect(review.report.revisedVersionId).toBe(versions[0]!.id);
    expect(review.report.revisionInstructions.length).toBeGreaterThan(0);
    expect(review.oocCount).toBe(0);
  });
  it('maxRevisions = 0：只审不改，未达标如实记下来（§2.3 第 3 条）', async () => {
    await saveStyleCheckConfig({ maxRevisions: 0 });
    const f = makeFetch({ reviewVerdict: 'revise' });
    setFetchImpl(f.fetch);
    const novel = await setupNovel(1, { withProfile: true, derivative: true });
    const jobId = await startGeneration(novel.id);
    await waitFor(async () => terminal(await getJob(jobId)));
    expect((await getJob(jobId))!.status).toBe('awaiting_review');
    expect(f.calls.filter((c) => c.kind === 'review')).toHaveLength(1);
    expect(f.calls.some((c) => c.kind === 'revise')).toBe(false);
    const ch = (await listChapters(novel.id))[0]!;
    // TEST: blocking review pauses before extraction and commit.
    const review = (await latestReviewForChapter(ch.id))!;
    expect(review.verdict).toBe('revise');
    expect(review.report.revisedVersionId).toBeNull();
    expect(await listVersions(ch.id)).toHaveLength(1);
  });
  it('TEST a rejected revision request preserves the blocking review for author action',async()=>{
    const f=makeFetch({reviewVerdict:'revise'});
    setFetchImpl(async(url,init)=>{
      const body=JSON.parse(String(init?.body));
      if(body.messages.some((m:{role:string;content:string})=>m.role==='system' && m.content.includes('局部修订编辑'))) return new Response('{"error":{"message":"TEST revision rejected"}}',{status:400});
      return f.fetch(url,init);
    });
    const novel=await setupNovel(1,{withProfile:true});
    const jobId=await startGeneration(novel.id);await waitFor(async()=>terminal(await getJob(jobId)));
    const chapter=(await listChapters(novel.id))[0]!,review=await latestReviewForChapter(chapter.id);
    expect((await getJob(jobId))!.status).toBe('awaiting_review');
    expect((await getJob(jobId))!.error).toContain('TEST revision rejected');
    expect(review?.chapterVersionId).toBe(chapter.currentVersionId);
    expect(review?.report.narrative?.some(issue=>issue.severity==='block' && !!issue.evidence.quote)).toBe(true);
    expect(chapter.committedVersionId).toBeNull();
  });
  it('maxRevisions = 2：改两轮仍不达标就停手，不无限循环', async () => {
    await saveStyleCheckConfig({ maxRevisions: 2 });
    const f = makeFetch({ reviewVerdict: 'revise' });
    setFetchImpl(f.fetch);
    const novel = await setupNovel(1, { withProfile: true, derivative: true });
    const jobId = await startGeneration(novel.id);
    await waitFor(async () => terminal(await getJob(jobId)));
    expect((await getJob(jobId))!.status).toBe('awaiting_review');
    // 初审 + 两轮修订后各复审一次
    expect(f.calls.filter((c) => c.kind === 'review')).toHaveLength(3);
    expect(f.calls.filter((c) => c.kind === 'revise')).toHaveLength(2);
    const ch = (await listChapters(novel.id))[0]!;
    expect((await latestReviewForChapter(ch.id))!.verdict).toBe('revise');
    expect((await listSteps(jobId)).find(s => s.kind === 'style_check')!.input.automaticRevisions).toBe(2);
    // TEST legacy in-flight tasks had revision versions but no durable counter.
    // Recover the counter even when their two-round allowance is already spent.
    const reviewStep = (await listSteps(jobId)).find(s => s.kind === 'style_check')!;
    await getDb().execute("UPDATE job_steps SET input=json_remove(input,'$.automaticRevisions') WHERE id=?",[reviewStep.id]);
    await resumeJob(jobId);
    await waitFor(async () => terminal(await getJob(jobId)));
    expect((await getJob(jobId))!.status).toBe('awaiting_review');
    expect(f.calls.filter(c => c.kind === 'revise')).toHaveLength(2);
    expect(f.calls.filter(c => c.kind === 'review')).toHaveLength(4);
    expect((await listSteps(jobId)).find(s => s.id === reviewStep.id)!.input.automaticRevisions).toBe(2);
    expect((await latestReviewForChapter(ch.id))!.verdict).toBe('revise');
  });
  it('作者附加指令拼进定点修订的 system 提示（§2.3 第 6 条）', async () => {
    await saveStyleCheckConfig({ maxRevisions: 1 });
    const f = makeFetch({ reviewVerdict: 'revise' });
    setFetchImpl(f.fetch);
    const novel = await setupNovel(1, { withProfile: true, derivative: true });
    await saveAuthorNote(novel.id, '每章至少出现一次天气。');
    const jobId = await startGeneration(novel.id);
    await waitFor(async () => terminal(await getJob(jobId)));
    expect((await getJob(jobId))!.status).toBe('awaiting_review');
    const revise = f.calls.find((c) => c.kind === 'revise')!;
    expect(revise.system).toContain('【作者附加指令】');
    expect(revise.system).toContain('每章至少出现一次天气。');
  });
  it('TEST style metrics remain advisory without narrative blockers', async () => {
    const f = makeFetch({ prose: () => flowery(6) });
    setFetchImpl(f.fetch);
    const novel = await setupNovel(1, { withProfile: true });
    const { styleProfile } = await getStyleExtras(novel.id);
    const { computeStyleMetrics } = await import('@/novel/styleMetrics');
    const { targetsFromMetrics } = await import('@the-water/shared');
    const metrics = computeStyleMetrics([terse(30)]);
    const { setStyleProfile } = await import('@/db/repos/storylineRepo');
    await setStyleProfile(novel.id, { ...styleProfile!, metrics, targets: targetsFromMetrics(metrics, 0.9) });
    const ch = (await listChapters(novel.id))[0]!;
    await createVersion({ chapterId: ch.id, content: flowery(6), source: 'generated' });
    const jobId = await startStyleCheck(novel.id, 1);
    await waitFor(async () => terminal(await getJob(jobId)));
    expect((await getJob(jobId))!.status).toBe('completed');
    const review = (await latestReviewForChapter(ch.id))!;
    expect(review.report.metricFindings.some((m) => m.key === 'sentenceMean' && m.hard)).toBe(true);
    expect(f.calls.some((c) => c.kind === 'revise')).toBe(false);
    expect(review.verdict).toBe('pass');
  });
});

describe('genre packs (L1) reach generation and the consistency channel', () => {
  it('TEST malformed consistency verdict cannot commit the chapter', async () => {
    const f = makeFetch();
    setFetchImpl(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.messages.some((m:{role:string;content:string}) => m.role === 'system' && m.content.includes('你是这本书的设定校对'))) {
        return sseResponse([sseBody([{data:{choices:[{delta:{content:JSON.stringify({numericConflicts:[],timelineConflicts:[],addressErrors:[],loreConflicts:[],verdict:'TEST invalid'})}}]}},{data:{choices:[{delta:{},finish_reason:'stop'}]}},{data:'[DONE]'}])]);
      }
      return f.fetch(url, init);
    });
    const novel = await setupNovel(1, { facts:['TEST 已知事实一','TEST 已知事实二','TEST 已知事实三'] });
    const jobId = await startGeneration(novel.id);
    await waitFor(async () => terminal(await getJob(jobId)));
    expect((await getJob(jobId))!.status).toBe('failed');
    expect((await getJob(jobId))!.error).toContain('verdict');
    expect((await listChapters(novel.id))[0]!.committedVersionId).toBeNull();
  });
  it('injects genre rules + lore into the writing prompt and records a passing consistency check', async () => {
    const f = makeFetch();
    setFetchImpl(f.fetch);
    const novel = await setupNovel(1, { requirements: { genre: '玄幻' }, facts: ['阿水目前是炼气三层', '他的刀是父亲留下的', '河神庙已经烧毁'] });
    const jobId = await startGeneration(novel.id);
    await waitFor(async () => terminal(await getJob(jobId)));
    expect(await status(jobId)).toMatch(/^completed/);
    const write = f.calls.find((c) => c.kind === 'write')!;
    // L1 写作规则进 system；lore 条目按 constant 进 user 侧的故事圣经。
    expect(write.system).toContain('题材惯例·仙侠 / 玄幻');
    expect(write.system).toContain('本书设定优先');
    expect(write.user).toContain('题材创作指导（非已确认事实');
    expect(write.user).toContain('境界体系');
    // 没有 StyleProfile 也要跑设定校对（按职能拆分，不依赖文风档案）。
    expect(f.calls.filter((c) => c.kind === 'consistency')).toHaveLength(1);
    expect(f.calls.some((c) => c.kind === 'review')).toBe(false);
    const consistency = f.calls.find((c) => c.kind === 'consistency')!;
    expect(consistency.user).not.toContain('[题材] 境界体系');
    expect(consistency.user).toContain('[本书] 阿水目前是炼气三层');
    expect(f.calls.find(c => c.kind === 'narrative')!.user).toContain('核心解法是否有前文依据');
    expect(consistency.user).toContain('阿水目前是炼气三层');
    const ch = (await listChapters(novel.id))[0]!;
    const review = (await latestReviewForChapter(ch.id))!;
    expect(review.verdict).toBe('pass');
    expect(review.report.consistency).not.toBeNull();
  });

  it('revises when the consistency channel finds a numeric conflict, and puts it first', async () => {
    const f = makeFetch({ consistency: 'revise', clearAfterRevision: true });
    setFetchImpl(f.fetch);
    const novel = await setupNovel(1, { requirements: { genrePackIds: ['xianxia'] }, facts: ['阿水目前是炼气三层', '他的刀是父亲留下的', '河神庙已经烧毁'] });
    const jobId = await startGeneration(novel.id);
    await waitFor(async () => terminal(await getJob(jobId)));
    expect(await status(jobId)).toMatch(/^completed/);
    const revise = f.calls.find((c) => c.kind === 'revise')!;
    expect(revise.user).toContain('他一步跨入元婴');
    expect(revise.user).toContain('境界体系');
    const ch = (await listChapters(novel.id))[0]!;
    const review = (await latestReviewForChapter(ch.id))!;
    expect(review.report.revisionInstructions[0]).toContain('境界体系');
    expect(review.report.consistency!.numericConflicts).toHaveLength(0);
    expect(f.calls.filter((c) => c.kind === 'consistency')).toHaveLength(2);
  });

  it('skips the consistency call when there is nothing to check against', async () => {
    const f = makeFetch();
    setFetchImpl(f.fetch);
    const novel = await setupNovel(1);
    const jobId = await startGeneration(novel.id);
    await waitFor(async () => terminal(await getJob(jobId)));
    expect(await status(jobId)).toMatch(/^completed/);
    expect(f.calls.some((c) => c.kind === 'consistency')).toBe(false);
  });
});


it('TEST mixed packs reach prose and narrative review without turning genre guidance into canon checks', async () => {
  const f = makeFetch();
  setFetchImpl(f.fetch);
  const novel = await setupNovel(1, { requirements: { genrePackIds: ['urban', 'xianxia', 'mystery'] } });
  const jobId = await startGeneration(novel.id);
  await waitFor(async () => terminal(await getJob(jobId)));
  expect(await status(jobId)).toMatch(/^completed/);
  expect(f.calls.some(c => c.kind === 'consistency')).toBe(false);
  expect(f.calls.some(c => c.kind === 'review')).toBe(false);
  const write = f.calls.find(c => c.kind === 'write')!;
  expect(write.system).toContain('特殊能力有稳定信息边界');
  expect(write.system).toContain('叙述者可以隐瞒、记错或说谎');
  expect(write.system).toContain('都市允许已确认的超自然设定');
  const narrative = f.calls.find(c => c.kind === 'narrative')!;
  expect(narrative.user).toContain('先核对作品承诺');
  expect(narrative.user).toContain('生活权限与信息来源');
  expect(narrative.user).toContain('非已确认事实');
});

it('TEST structural weakness triggers revision even when all factual checks pass', async()=>{
  const f=makeFetch({story:'revise'});setFetchImpl(f.fetch);
  const novel=await setupNovel(1),chapter=(await listChapters(novel.id))[0]!;
  await createVersion({chapterId:chapter.id,content:terse(14),source:'generated'});
  const id=await startStyleCheck(novel.id,1);
  await waitFor(async()=>terminal(await getJob(id)));
  expect(await status(id)).toMatch(/^completed/);
  expect(f.calls.filter(c=>c.kind==='revise')).toHaveLength(1);
  expect((await latestReviewForChapter(chapter.id))!.report.story?.verdict).toBe('ready');
  expect((await listVersions(chapter.id))[0]!.content).toContain('他按住刀鞘');
});
it('TEST a plan-level problem preserves manuscript and prevents committing a false pass',async()=>{
  const f=makeFetch({story:'replan'});setFetchImpl(f.fetch);
  const novel=await setupNovel(1),chapter=(await listChapters(novel.id))[0]!;
  const draft=await createVersion({chapterId:chapter.id,content:terse(14),source:'generated'});
  const id=await startStyleCheck(novel.id,1);
  await waitFor(async()=>terminal(await getJob(id)));
  expect((await getJob(id))!.status).toBe('awaiting_review');
  expect((await getChapter(chapter.id))!.currentVersionId).toBe(draft.id);
  expect((await getChapter(chapter.id))!.committedVersionId).toBeNull();
  expect(f.calls.filter(c=>c.kind==='revise')).toHaveLength(0);
});
it('TEST stylistic preference does not force structural revision',async()=>{
  const f=makeFetch({story:'opinion'});setFetchImpl(f.fetch);
  const novel=await setupNovel(1),chapter=(await listChapters(novel.id))[0]!;
  const draft=await createVersion({chapterId:chapter.id,content:terse(14),source:'generated'});
  const id=await startStyleCheck(novel.id,1);
  await waitFor(async()=>terminal(await getJob(id)));
  expect((await getJob(id))!.status).toBe('completed');
  expect(f.calls.filter(c=>c.kind==='revise')).toHaveLength(0);
  expect((await getChapter(chapter.id))!.currentVersionId).toBe(draft.id);
});

it('TEST automatic narrative repair of committed prose remains pending author adoption',async()=>{
 const novel=await setupNovel(1);
 const ch=(await listChapters(novel.id))[0]!;
 const baseline=await createVersion({chapterId:ch.id,content:terse(14),source:'generated'});
 const {stageTestChapter}=await import('../helpers/writing');
 const {commitPreparedChapter}=await import('@/db/repos/writingRepo');
 await stageTestChapter(ch.id);
 await commitPreparedChapter(ch.id,baseline.id);
 const f=makeFetch({story:'revise'});setFetchImpl(f.fetch);
 const id=await startStyleCheck(novel.id,1);
 await waitFor(async()=>terminal(await getJob(id)));
 expect((await getJob(id))!.status).toBe('awaiting_review');
 const current=(await getChapter(ch.id))!;
 expect(current.committedVersionId).toBe(baseline.id);
 expect(current.rewriteBaselineVersionId).toBe(baseline.id);
 expect(current.currentVersionId).not.toBe(baseline.id);
});

it.each(['expand','trim'] as const)('TEST evidenced %s diagnosis drives a scoped revision and is reviewed again',async(lengthAction)=>{
  const f=makeFetch({story:'revise',lengthAction});setFetchImpl(f.fetch);
  const novel=await setupNovel(1),chapter=(await listChapters(novel.id))[0]!;
  await createVersion({chapterId:chapter.id,content:terse(14),source:'generated'});
  const id=await startStyleCheck(novel.id,1);
  await waitFor(async()=>terminal(await getJob(id)));
  expect((await getJob(id))!.status).toBe('completed');
  expect(f.calls.filter(c=>c.kind==='revise')).toHaveLength(1);
  expect(f.calls.filter(c=>c.kind==='narrative')).toHaveLength(2);
  const report=(await latestReviewForChapter(chapter.id))!.report;
  expect(report.lengthReview?.action).toBe('keep');
  expect(report.revisionInstructions[0]).toContain('我错了');
});
it('TEST optional trim preference is displayed with evidence without forcing a rewrite',async()=>{
  const f=makeFetch({story:'opinion',lengthAction:'trim'});setFetchImpl(f.fetch);
  const novel=await setupNovel(1),chapter=(await listChapters(novel.id))[0]!;
  const draft=await createVersion({chapterId:chapter.id,content:terse(14),source:'generated'});
  const id=await startStyleCheck(novel.id,1);await waitFor(async()=>terminal(await getJob(id)));
  expect((await getJob(id))!.status).toBe('completed');
  const report=(await latestReviewForChapter(chapter.id))!.report;
  expect(report.lengthReview?.action).toBe('trim');
  expect(report.narrative?.find(issue=>issue.id===report.lengthReview!.actions[0]!.issueId)?.evidence.quote).toBe('我错了');
  expect((await getChapter(chapter.id))!.currentVersionId).toBe(draft.id);
  expect(f.calls.filter(c=>c.kind==='revise')).toHaveLength(0);
});
