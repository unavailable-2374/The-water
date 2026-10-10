/** TEST fixtures: structural edits, history, concurrency and reviewed export contracts. */
import { beforeEach, it, expect } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { stageTestChapter } from '../helpers/writing';
import { createNovel } from '@/db/repos/novelsRepo';
import {
  createVersion,
  getChapter,
  getVersion,
  listChapters,
  listArchivedChapters,
  listCurrentVersions,
  saveSessionEdit,
  upsertChapterPlan,
} from '@/db/repos/chaptersRepo';
import {
  splitChapter,
  reorderChapters,
  mergeChapters,
  cancelChapterMerge,
} from '@/db/repos/chapterStructureRepo';
import {
  commitPreparedChapter,
  listCanonEvents,
  stageExtraction,
  chapterDependencies,
} from '@/db/repos/writingRepo';
import { reviewForVersion } from '@/db/repos/reviewsRepo';
import { createJob, upgradeLegacyJobs, listSteps, getJob } from '@/db/repos/jobsRepo';
import { getDb } from '@/db/db';
import { defaultRequirements } from '@/novel/types';
import { applyRevisionPatches } from '@/novel/textProposals';
import type { ReviewIssue } from '@the-water/shared';
beforeEach(() => useTestDb());
async function fixture() {
  const n = await createNovel({
    title: 'TEST structure',
    premise: 'TEST',
    requirements: defaultRequirements(),
    targetChars: 6000,
  });
  const c = [];
  for (let i = 1; i <= 3; i++) {
    const chapter = await upsertChapterPlan(n.id, { chapterNo: i, title: `TEST ${i}`, targetChars: 2000 });
    await createVersion({ chapterId: chapter.id, content: `TEST prose ${i}`, source: 'generated' });
    const v = await stageTestChapter(chapter.id);
    await commitPreparedChapter(chapter.id, v.id);
    c.push((await getChapter(chapter.id))!);
  }
  return { n, c };
}
it('TEST split retains official prose and all source versions while creating two candidate halves', async () => {
  const { n, c } = await fixture();
  const source = (await getVersion(c[0]!.currentVersionId!))!;
  const id = await splitChapter(c[0]!.id, 5);
  const chapters = await listChapters(n.id);
  expect(chapters.map((x) => x.chapterNo)).toEqual([1, 2, 3, 4]);
  expect(
    (await getVersion((await getChapter(c[0]!.id))!.currentVersionId!))!.content +
      (await getVersion((await getChapter(id))!.currentVersionId!))!.content,
  ).toBe(source.content);
  expect((await listCurrentVersions(n.id))[0]!.version!.content).toBe(source.content);
  expect(await getVersion(source.id)).not.toBeNull();
  await reorderChapters(
    n.id,
    [...chapters].reverse().map((c) => c.id),
  );
  expect((await listChapters(n.id))[0]!.id).toBe(c[2]!.id);
});
it('TEST merge archives only with the reviewed replacement, retaining original history', async () => {
  const { n, c } = await fixture();
  await mergeChapters(c[0]!.id, c[1]!.id);
  expect(await listChapters(n.id)).toHaveLength(3);
  expect((await listCurrentVersions(n.id))[0]!.version!.content).toBe('TEST prose 1');
  const candidate = await stageTestChapter(c[0]!.id);
  await commitPreparedChapter(c[0]!.id, candidate.id);
  expect((await listChapters(n.id)).map((c) => c.chapterNo)).toEqual([1, 2]);
  expect(await listArchivedChapters(n.id)).toHaveLength(1);
  expect((await listCurrentVersions(n.id))[0]!.version!.content).toBe('TEST prose 1\n\nTEST prose 2');
  expect((await getVersion(c[1]!.committedVersionId!))!.content).toBe('TEST prose 2');
});
it('TEST concurrent edits to the merged chapter reject archival and rollback the commit', async () => {
  const { n, c } = await fixture();
  await mergeChapters(c[0]!.id, c[1]!.id);
  const candidate = await stageTestChapter(c[0]!.id);
  await saveSessionEdit({ chapterId: c[1]!.id, content: 'TEST concurrent edit', sessionId: 'TEST' });
  await expect(commitPreparedChapter(c[0]!.id, candidate.id)).rejects.toThrow('Concurrent modification');
  expect(await listChapters(n.id)).toHaveLength(3);
  expect((await getVersion(candidate.id))!.committedAt).toBeNull();
  await cancelChapterMerge(c[0]!.id);
  expect((await getVersion((await getChapter(c[0]!.id))!.currentVersionId!))!.content).toBe('TEST prose 1');
});
it('TEST unfinished legacy job receives mandatory gates exactly once', async () => {
  const { n, c } = await fixture();
  const j = await createJob({
    novelId: n.id,
    type: 'rewrite',
    params: {},
    providerId: null,
    steps: [{ kind: 'rewrite_chapter', chapterId: c[0]!.id }],
  });
  await getDb().execute("UPDATE generation_jobs SET params='{}',status='running' WHERE id=?", [j.id]);
  await getDb().execute("UPDATE job_steps SET status='running',partial_text='TEST partial' WHERE job_id=?", [
    j.id,
  ]);
  await upgradeLegacyJobs();
  await upgradeLegacyJobs();
  expect((await listSteps(j.id))[0]!.status).toBe('pending');
  expect((await listSteps(j.id))[0]!.partialText).toBe('TEST partial');
  expect((await listSteps(j.id)).map((s) => s.kind)).toEqual([
    'rewrite_chapter',
    'style_check',
    'summarize',
    'commit_chapter',
  ]);
  expect((await getJob(j.id))!.status).toBe('awaiting_review');
});
it('TEST same-chapter dependency IDs are remapped as a DAG; future and cyclic edges fail', async () => {
  const { n, c } = await fixture();
  const v = await createVersion({
    chapterId: c[0]!.id,
    source: 'user_edit',
    content: 'TEST cause then TEST effect',
  });
  await stageTestChapter(c[0]!.id);
  const review = (await reviewForVersion(v.id))!,
    deps = await chapterDependencies(n.id, 1);
  const event = {
    id: 'TEST-a',
    kind: 'event' as const,
    entityId: null,
    threadId: null,
    text: 'TEST cause',
    knownBy: [],
    time: '',
    location: '',
    dependencyIds: [] as string[],
    evidence: { from: 0, to: 10, quote: 'TEST cause' },
  };
  const second = {
    ...event,
    id: 'TEST-b',
    text: 'TEST effect',
    dependencyIds: ['TEST-a'],
    evidence: { from: 16, to: 27, quote: 'TEST effect' },
  };
  await expect(
    stageExtraction(c[0]!.id, v.id, review.id, deps.hash, { summary: 'TEST', events: [second, event] }),
  ).rejects.toThrow('依赖');
  await stageExtraction(c[0]!.id, v.id, review.id, deps.hash, { summary: 'TEST', events: [event, second] });
  await commitPreparedChapter(c[0]!.id, v.id);
  const events = await listCanonEvents(n.id, 2);
  expect(events.find((e) => e.text === 'TEST effect')!.dependencyIds).toEqual([
    events.find((e) => e.text === 'TEST cause')!.id,
  ]);
});
it('TEST localized revision preserves unrelated text and rejects overlapping or remote edits', () => {
  const text = 'TEST 前段。错误信息。TEST 后段。';
  const issue = {
    id: 'TEST',
    category: 'canon',
    severity: 'block',
    evidence: { from: 8, to: 12, quote: '错误信息' },
    basis: 'TEST rule',
    suggestion: 'TEST fix',
    sourceIds: [],
  } satisfies ReviewIssue;
  expect(
    applyRevisionPatches(text, [{ from: 8, to: 12, original: '错误信息', replacement: '更正信息' }], [issue])
      .text,
  ).toBe('TEST 前段。更正信息。TEST 后段。');
  expect(() =>
    applyRevisionPatches(text, [{ from: 0, to: 4, original: 'TEST', replacement: 'FAKE' }], [issue]),
  ).toThrow('范围');
});
