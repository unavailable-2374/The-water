/** TEST fixtures verify contracts; they make no claim about real model quality. */
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { stageTestChapter, testScene } from '../helpers/writing';
import { createNovel } from '@/db/repos/novelsRepo';
import {
  createVersion,
  getChapter,
  getVersion,
  listCurrentVersions,
  restoreVersion,
  saveSessionEdit,
  upsertChapterPlan,
  resolveRewrite,
} from '@/db/repos/chaptersRepo';
import {
  chapterDependencies,
  commitPreparedChapter,
  listCanonEvents,
  stageExtraction,
  listWritingCards,
  saveWritingCard,
  type Extraction,
} from '@/db/repos/writingRepo';
import {
  ChapterReviewJsonSchema,
  assertReviewPass,
  dismissReviewIssue,
  saveReview,
} from '@/db/repos/reviewsRepo';
import { getDb } from '@/db/db';
import { defaultRequirements } from '@/novel/types';
import {
  sha256Hex,
  anchorEvidence,
  emptyStoryline,
  type ReviewIssue,
  type TextProposal,
} from '@the-water/shared';
import { applyTextProposal } from '@/novel/textProposals';
import { proposeDocumentPlan, acceptDocumentPlan } from '@/db/repos/planProposalsRepo';
import { buildStorylineDoc } from '@/db/repos/storylineRepo';
import { buildChapterContextText } from '@/jobs/steps/common';
import { remapStoryline, remapMaterialCard } from '@/sync/fork';
import {createJob,getJob,listSteps,setJobStatus,stepFailed,updateProgress} from '@/db/repos/jobsRepo';

beforeEach(() => useTestDb());
it('TEST adopting reviewed prose atomically completes only its waiting commit checkpoint',async()=>{
 const {n,chapters}=await setup();const chapter=chapters[0]!;
 const baseline=await createVersion({chapterId:chapter.id,content:'TEST baseline',source:'generated'});
 const candidate=await createVersion({chapterId:chapter.id,content:'TEST revised manuscript',source:'rewritten'});
 await getDb().execute('UPDATE chapters SET rewrite_baseline_version_id=? WHERE id=?',[baseline.id,chapter.id]);
 await stageTestChapter(chapter.id);
 const job=await createJob({novelId:n.id,type:'rewrite',params:{},providerId:null,steps:[{kind:'commit_chapter',chapterId:chapter.id}]});
 const step=(await listSteps(job.id))[0]!;
 await stepFailed(step.id,'改写稿已审查，等待作者采纳');
 await setJobStatus(job.id,'awaiting_review');
 await updateProgress(job.id,{done:0,total:1,currentStepId:step.id,charsSoFar:0,message:'TEST waiting author'});
 await resolveRewrite(chapter.id,'accept');
 expect((await getChapter(chapter.id))?.committedVersionId).toBe(candidate.id);
 expect((await getJob(job.id))?.status).toBe('completed');
 expect((await getJob(job.id))?.progress.currentStepId).toBeNull();
 expect((await listSteps(job.id))[0]?.status).toBe('done');
});
async function setup(count = 1) {
  const n = await createNovel({
    title: 'TEST workbench',
    premise: 'TEST',
    requirements: defaultRequirements(),
    targetChars: 3000 * count,
  });
  const chapters = [];
  for (let i = 1; i <= count; i++)
    chapters.push(await upsertChapterPlan(n.id, { chapterNo: i, title: `TEST ${i}`, targetChars: 3000 }));
  return { n, chapters };
}
async function prepare(chapterId: string, events: Extraction['events'] = []) {
  const v = await stageTestChapter(chapterId),
    ch = (await getChapter(chapterId))!;
  const deps = await chapterDependencies(ch.novelId, ch.chapterNo);
  const r = await saveReview({
    novelId: ch.novelId,
    chapterId,
    chapterVersionId: v.id,
    styleScore: 100,
    oocCount: 0,
    verdict: 'pass',
    report: ChapterReviewJsonSchema.parse({ narrative: [] }),
  });
  await stageExtraction(chapterId, v.id, r.id, deps.hash, { summary: 'TEST summary', events });
  return { v, r, deps };
}
const event = (quote: string): Extraction['events'][number] => ({
  id: 'TEST-event',
  kind: 'fact',
  entityId: null,
  threadId: null,
  text: 'TEST witnessed fact',
  knownBy: [],
  time: 'TEST t1',
  location: 'TEST location',
  dependencyIds: [],
  evidence: { from: 0, to: quote.length, quote },
});

describe('TEST atomic prose and canon', () => {
  it('candidate, discard/restore and default export never publish unreviewed facts', async () => {
    const {
      n,
      chapters: [c],
    } = await setup();
    const a = await createVersion({ chapterId: c!.id, content: 'TEST witnessed', source: 'generated' });
    await prepare(c!.id, [event(a.content)]);
    await commitPreparedChapter(c!.id, a.id);
    const b = await createVersion({ chapterId: c!.id, content: 'TEST imagined', source: 'user_edit' });
    expect((await listCurrentVersions(n.id))[0]!.version!.id).toBe(a.id);
    expect((await listCurrentVersions(n.id, { draft: true }))[0]!.version!.id).toBe(b.id);
    expect((await listCanonEvents(n.id, 2)).map((e) => e.text)).toEqual(['TEST witnessed fact']);
    await restoreVersion(c!.id, a.id);
    expect((await getChapter(c!.id))!.currentVersionId).not.toBe(a.id);
    expect((await getChapter(c!.id))!.committedVersionId).toBe(a.id);
    await expect(
      getDb().execute('UPDATE chapter_versions SET content=? WHERE id=?', ['TEST corrupt', a.id]),
    ).rejects.toThrow('Committed versions are immutable');
  });
  it('stale hashes, changed dependencies and concurrent editors fail closed', async () => {
    const {
      n,
      chapters: [c],
    } = await setup();
    const a = await saveSessionEdit({
      chapterId: c!.id,
      sessionId: 'TEST session',
      content: 'TEST original',
    });
    const { r, deps } = await prepare(c!.id);
    await saveSessionEdit({
      chapterId: c!.id,
      sessionId: 'TEST session',
      content: 'TEST edited',
      expectedHash: a.contentHash,
    });
    await expect(commitPreparedChapter(c!.id, a.id)).rejects.toThrow();
    await expect(assertReviewPass(r.id, a.id, a.contentHash, deps.hash)).rejects.toThrow();
    await expect(
      saveSessionEdit({
        chapterId: c!.id,
        sessionId: 'TEST session',
        content: 'TEST lost update',
        expectedHash: a.contentHash,
      }),
    ).rejects.toThrow('Concurrent modification');
    await prepare(c!.id);
    await testScene(n.id, c!.id);
    await expect(commitPreparedChapter(c!.id, a.id)).rejects.toThrow();
  });
  it('transaction interruption rolls back pointers, events, review invalidation and commit; retry is idempotent', async () => {
    const {
      n,
      chapters: [c],
    } = await setup();
    const v = await createVersion({ chapterId: c!.id, content: 'TEST source', source: 'generated' });
    await prepare(c!.id, [event(v.content)]);
    await getDb().execute(
      "CREATE TRIGGER test_interrupt BEFORE INSERT ON canon_events BEGIN SELECT RAISE(ABORT,'TEST interrupted transaction'); END",
    );
    await expect(commitPreparedChapter(c!.id, v.id)).rejects.toThrow('TEST interrupted transaction');
    expect((await getChapter(c!.id))!.committedVersionId).toBeNull();
    expect((await getVersion(v.id))!.committedAt).toBeNull();
    expect(await listCanonEvents(n.id, 2)).toEqual([]);
    await getDb().execute('DROP TRIGGER test_interrupt');
    const id = await commitPreparedChapter(c!.id, v.id);
    expect(await commitPreparedChapter(c!.id, v.id)).toBe(id);
    expect(await getDb().select('SELECT id FROM chapter_commits')).toHaveLength(1);
  });
  it('committing an earlier change preserves later prose and invalidates later evidence', async () => {
    const { n, chapters } = await setup(2);
    for (const c of chapters) {
      await createVersion({ chapterId: c.id, content: `TEST chapter ${c.chapterNo}`, source: 'generated' });
      const { v } = await prepare(c.id, [event(`TEST chapter ${c.chapterNo}`)]);
      await commitPreparedChapter(c.id, v.id);
    }
    const later = (await getChapter(chapters[1]!.id))!.committedVersionId;
    const v = await createVersion({
      chapterId: chapters[0]!.id,
      content: 'TEST revision',
      source: 'user_edit',
    });
    await prepare(chapters[0]!.id);
    await commitPreparedChapter(chapters[0]!.id, v.id);
    expect(await getChapter(chapters[1]!.id)).toMatchObject({
      committedVersionId: later,
      memoryStatus: 'stale',
    });
    expect(await listCanonEvents(n.id, 3)).toEqual([]);
    expect((await getVersion(later!))!.content).toBe('TEST chapter 2');
  });
  it('confirmed future scene cards do not invalidate earlier scene dependencies', async () => {
    const { n, chapters } = await setup(2);
    await testScene(n.id, chapters[0]!.id);
    const before = await chapterDependencies(n.id, 1);
    await testScene(n.id, chapters[1]!.id);
    expect((await chapterDependencies(n.id, 1)).hash).toBe(before.hash);
  });
});

describe('TEST narrative gates', () => {
  it.each(['knowledge', 'motivation', 'timeline', 'thread', 'ending', 'canon'] as const)(
    'blocks %s until a reasoned false-positive decision',
    async (category) => {
      const {
        n,
        chapters: [c],
      } = await setup();
      const text = `TEST ${category} contradiction`,
        v = await createVersion({ chapterId: c!.id, content: text, source: 'generated' });
      const issue: ReviewIssue = {
        id: 'TEST issue',
        category,
        severity: 'block',
        evidence: { from: 0, to: text.length, quote: text },
        basis: 'TEST explicit confirmed constraint',
        suggestion: 'TEST fix the stated contradiction',
        sourceIds: [],
      };
      const r = await saveReview({
        novelId: n.id,
        chapterId: c!.id,
        chapterVersionId: v.id,
        styleScore: 100,
        oocCount: 0,
        verdict: 'pass',
        report: ChapterReviewJsonSchema.parse({ narrative: [issue] }),
      });
      const deps = await chapterDependencies(n.id, 1);
      await expect(assertReviewPass(r.id, v.id, v.contentHash, deps.hash)).rejects.toThrow('阻断');
      await expect(dismissReviewIssue(r.id, issue.id, ' ')).rejects.toThrow();
      await dismissReviewIssue(r.id, issue.id, 'TEST evidence actually refers to the other speaker');
      await expect(assertReviewPass(r.id, v.id, v.contentHash, deps.hash)).resolves.toBeDefined();
    },
  );
  it('evidence anchoring accepts unique exact quotes, rejects absent or ambiguous quotes', () => {
    expect(anchorEvidence('TEST 中文🌊证据', { from: 0, to: 1, quote: '🌊证据' })).toEqual({
      from: 7,
      to: 11,
      quote: '🌊证据',
    });
    expect(() => anchorEvidence('TEST 重复 重复', { from: 0, to: 1, quote: '重复' })).toThrow('ambiguous');
    expect(() => anchorEvidence('TEST 原文', { from: 0, to: 1, quote: '不存在' })).toThrow();
  });
  it('thread closure requires the same stable ID, not a substring', async () => {
    const {
      n,
      chapters: [c],
    } = await setup();
    const v = await createVersion({ chapterId: c!.id, content: 'TEST payoff', source: 'generated' });
    const id = await saveWritingCard(
      n.id,
      {
        kind: 'thread',
        data: {
          title: 'TEST thread',
          setup: 'TEST setup',
          progression: '',
          payoff: '',
          plannedChapterNo: 1,
          characterIds: [],
        },
      },
      { confirmed: true },
    );
    await prepare(c!.id, [{ ...event(v.content), kind: 'thread_payoff', threadId: id }]);
    await expect(commitPreparedChapter(c!.id, v.id)).rejects.toThrow('伏笔尚未埋设');
    expect(await listCanonEvents(n.id, 2)).toEqual([]);
  });
});

describe('TEST planning/editor contracts', () => {
  it('plan proposals have no effect until accepted and preserve version history', async () => {
    const {
      n,
      chapters: [c],
    } = await setup();
    const v = await createVersion({ chapterId: c!.id, content: 'TEST prose', source: 'imported' });
    const before = await buildStorylineDoc(n.id, n.premise, []),
      after = { ...before, chapters: before.chapters.map((p) => ({ ...p, title: 'TEST new title' })) };
    const id = await proposeDocumentPlan(n.id, after, 'TEST change');
    expect((await getChapter(c!.id))!.title).toBe('TEST 1');
    await acceptDocumentPlan(n.id, id);
    expect((await getChapter(c!.id))!.title).toBe('TEST new title');
    expect((await getVersion(v.id))!.content).toBe('TEST prose');
  });
  it('text proposals rebase verified disjoint edits and retain conflicts', async () => {
    const base = 'TEST 左侧中文。中间。右侧文本。';
    const from = base.indexOf('中间');
    const p: TextProposal = {
      id: 'TEST p',
      chapterId: 'TEST ch',
      baseVersionId: 'TEST v',
      baseHash: await sha256Hex(base),
      operation: 'rewrite',
      from,
      to: from + 2,
      original: '中间',
      replacement: '候选',
      sourceIds: [],
    };
    expect(await applyTextProposal(p, base, '前缀' + base)).toContain('候选');
    await expect(applyTextProposal(p, base, base.replace('中间', '作者已改'))).rejects.toThrow('冲突');
  });
  it('500 chapter TEST project loads only nearby prose and pauses when required context cannot fit', async () => {
    const { n, chapters } = await setup(500);
    for (const c of chapters) await testScene(n.id, c.id);
    const doc = await buildStorylineDoc(n.id, n.premise, []);
    const env = {
      novel: n,
      chapter: chapters[499]!,
      doc,
      bible: { characters: {}, facts: [], timeline: [], openThreads: [], arcSummaries: {}, styleNotes: '' },
      snapshotId: null,
      chapters,
    };
    const caps = {
      contextWindow: 64000,
      maxOutputTokens: 6000,
      jsonMode: 'json_object' as const,
      cjkTokenRatio: 0.7,
    };
    const provider = {
      id: 'TEST',
      kind: 'openai_compatible' as const,
      model: 'TEST',
      caps,
      async *stream() {
        throw new Error('TEST must not call a model');
      },
    };
    const text = await buildChapterContextText(env, provider, 2000);
    expect(text).toContain('TEST scene');
    expect(text.length).toBeLessThan(30000);
    await expect(
      buildChapterContextText(env, { ...provider, caps: { ...caps, contextWindow: 100 } }, 2000),
    ).rejects.toThrow('窗口');
    expect(await listWritingCards(n.id, { chapterId: chapters[499]!.id })).toHaveLength(1);
  });
  it('fork remaps global IDs and cross references', () => {
    const doc = {
      ...emptyStoryline(),
      arcs: [{ id: 'TEST a', title: 'TEST', summary: '', startChapterNo: 1, endChapterNo: 1 }],
    };
    const ids = new Map<string, string>();
    const copy = remapStoryline(doc, ids);
    expect(copy.arcs[0]!.id).not.toBe(doc.arcs[0]!.id);
    expect(
      remapMaterialCard(
        {
          kind: 'volume',
          data: { title: 'TEST', summary: '', startChapterNo: 1, endChapterNo: 1, arcIds: ['TEST a'] },
        },
        ids,
      ).data,
    ).toHaveProperty('arcIds', [copy.arcs[0]!.id]);
  });
});

it('TEST candidate CAS detects autosave that changed content without changing the version ID', async () => {
  const {
    chapters: [chapter],
  } = await setup();
  const base = await saveSessionEdit({
    chapterId: chapter!.id,
    sessionId: 'TEST-session',
    content: 'TEST initial',
  });
  const edited = await saveSessionEdit({
    chapterId: chapter!.id,
    sessionId: 'TEST-session',
    content: 'TEST concurrent author edit',
  });
  expect(edited.id).toBe(base.id);
  await expect(
    createVersion({
      chapterId: chapter!.id,
      source: 'generated',
      content: 'TEST stale model result',
      expectedWorkingVersionId: base.id,
      expectedWorkingHash: base.contentHash,
    }),
  ).rejects.toThrow('Concurrent modification');
  expect((await getVersion(base.id))!.content).toBe('TEST concurrent author edit');
});

it('TEST linked dialogue edits must share an anchored continuous patch; touching a boundary is insufficient',async()=>{
 const {applyRevisionPatches}=await import('@/novel/textProposals');
 const text='TEST 四点四十五分。窗外下雨。还有一刻钟。';
 const issue:ReviewIssue={id:'TEST-time',category:'timeline',severity:'block',evidence:{from:5,to:11,quote:'四点四十五分'},basis:'TEST five oclock',suggestion:'TEST fix time',sourceIds:[]};
 const dialogue={from:17,to:22,original:'还有一刻钟',replacement:'刚交班'};
 expect(()=>applyRevisionPatches(text,[dialogue],[issue])).toThrow('还有一刻钟');
 expect(()=>applyRevisionPatches(text,[{from:11,to:12,original:'。',replacement:'！'}],[issue])).toThrow('修订范围没有覆盖');
 const combined={from:5,to:22,original:'四点四十五分。窗外下雨。还有一刻钟',replacement:'五点整。窗外下雨。刚交班'};
 expect(applyRevisionPatches(text,[combined],[issue]).text).toBe('TEST 五点整。窗外下雨。刚交班。');
});

it('TEST selected genre rules are present as citeable required sources',async()=>{
 const {n,chapters:[chapter]}=await setup();
 const novel={...n,requirements:{...n.requirements,genrePackIds:['xianxia']}};
 const doc=await buildStorylineDoc(n.id,n.premise,[]);const sourceIds:string[]=[];
 const provider={id:'TEST',kind:'openai_compatible' as const,model:'TEST',caps:{contextWindow:64000,maxOutputTokens:6000,jsonMode:'json_object' as const,cjkTokenRatio:0.7},async *stream(){throw new Error('TEST no model calls');}};
 const text=await buildChapterContextText({novel,chapter:chapter!,chapters:[chapter!],doc,bible:{characters:{},facts:[],timeline:[],openThreads:[],arcSummaries:{},styleNotes:''},snapshotId:null},provider,2000,{onSources:ids=>sourceIds.push(...ids)});
 expect(sourceIds).toContain('xianxia:realms');expect(text).toContain('"id":"xianxia:realms"');
});
