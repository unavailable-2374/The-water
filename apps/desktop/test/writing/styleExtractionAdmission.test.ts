/** TEST fictional prose; no provider output is simulated or requested in these admission tests. */
import { beforeEach, expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { createNovel } from '@/db/repos/novelsRepo';
import { createVersion, upsertChapterPlan } from '@/db/repos/chaptersRepo';
import { listJobs } from '@/db/repos/jobsRepo';
import { defaultRequirements } from '@/novel/types';
import { listStyleExtractionSources } from '@/novel/styleExtractionSources';
import { startStyleExtraction } from '@/novel/service';
import { queueStyleExtraction } from '@/sync/fork';
import { sampleStyleSources } from '@/jobs/steps/extractStyleStep';

beforeEach(() => useTestDb());
async function fixture() {
  const novel = await createNovel({ title: 'TEST short input', premise: 'TEST', targetChars: 100, requirements: defaultRequirements() });
  const chapter = await upsertChapterPlan(novel.id, { chapterNo: 1, title: 'TEST short chapter' });
  await createVersion({ chapterId: chapter.id, content: 'TEST 他留下信件。', source: 'imported', status: 'final' });
  return novel;
}
it('short import does not queue an inevitably failing automatic extraction', async () => {
  const novel = await fixture(), messages: string[] = [];
  await queueStyleExtraction(novel.id, message => messages.push(message));
  expect(await listJobs({ novelId: novel.id })).toEqual([]);
  expect(messages.join('')).toContain('正文样本不足');
});
it('manual extraction rejects missing eligible prose before creating a task', async () => {
  const novel = await fixture();
  await expect(startStyleExtraction(novel.id)).rejects.toThrow('至少需要一章超过 200 字');
  expect(await listJobs({ novelId: novel.id })).toEqual([]);
});
it('filtering short chapters does not remove later eligible chapters from sampling', async () => {
  const novel = await fixture();
  for (const chapterNo of [2, 7]) {
    const chapter = await upsertChapterPlan(novel.id, { chapterNo, title: 'TEST eligible' });
    await createVersion({ chapterId: chapter.id, content: 'TEST 核对记录。'.repeat(30), source: 'imported', status: 'final' });
  }
  const rows = await listStyleExtractionSources(novel.id);
  expect(rows.map(row => row.chapter.chapterNo)).toEqual([2, 7]);
  expect(sampleStyleSources(rows).map(row => row.chapter.chapterNo)).toEqual([2, 7]);
});
