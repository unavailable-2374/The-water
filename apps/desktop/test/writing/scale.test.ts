/** TEST: generated fixture prose, scripted review passes; no model quality evidence. */
import { expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { stageTestChapter, testScene } from '../helpers/writing';
import { createNovel } from '@/db/repos/novelsRepo';
import { createVersion, getChapter, upsertChapterPlan } from '@/db/repos/chaptersRepo';
import { buildStorylineDoc, replaceStorylineRows } from '@/db/repos/storylineRepo';
import {
  chapterDependencies,
  commitPreparedChapter,
  stageExtraction,
  pageCanonEvents,
  invalidateMemoryOperations,
  listWritingCards,
} from '@/db/repos/writingRepo';
import { bibleBeforeChapter, listBibleSnapshots } from '@/db/repos/bibleRepo';
import { reviewForVersion } from '@/db/repos/reviewsRepo';
import { buildChapterContextText } from '@/jobs/steps/common';
import { defaultRequirements } from '@/novel/types';
import { countZh, emptyStoryline, emptyVoice } from '@the-water/shared';

it('TEST 500 committed chapters retain a million characters and complete canon without duplicating event history in snapshots', async () => {
  const db = useTestDb();
  const novel = await createNovel({
    title: 'TEST million-character fixture',
    premise: 'TEST synthetic fixture only',
    requirements: defaultRequirements(),
    targetChars: 1000000,
  });
  const doc = {
    ...emptyStoryline(),
    premise: novel.premise,
    characters: ['TEST-pov', 'TEST-other'].map((id) => ({
      ...emptyVoice(),
      id,
      name: id,
      aliases: [],
      role: 'TEST',
      description: 'TEST fixture',
      arc: '',
      relationships: [],
    })),
  };
  await replaceStorylineRows(novel.id, doc);
  const chapters = [];
  for (let i = 1; i <= 500; i++) {
    const c = await upsertChapterPlan(novel.id, {
      chapterNo: i,
      title: `TEST ${i}`,
      goal: 'TEST',
      targetChars: 2000,
      povCharacterId: i === 500 ? 'TEST-pov' : 'TEST-other',
    });
    chapters.push(c);
    await testScene(novel.id, c.id, i === 500 ? 'TEST-pov' : 'TEST-other');
  }
  let totalChars = 0;
  for (const chapter of chapters) {
    const quotes = Array.from({ length: 5 }, (_, i) => `TEST evidence ${chapter.chapterNo}/${i}`),
      content = quotes.join('\n') + '\n' + '测试正文'.repeat(500);
    totalChars += countZh(content);
    const version = await createVersion({ chapterId: chapter.id, content, source: 'user_edit' });
    await stageTestChapter(chapter.id);
    const review = (await reviewForVersion(version.id))!,
      deps = await chapterDependencies(novel.id, chapter.chapterNo);
    await stageExtraction(chapter.id, version.id, review.id, deps.hash, {
      summary: 'TEST summary',
      events: quotes.map((quote, i) => ({
        id: `TEST-local-${i}`,
        kind: 'event' as const,
        entityId: chapter.chapterNo === 1 ? 'TEST-pov' : 'TEST-other',
        threadId: null,
        text: quote,
        knownBy: [],
        time: `TEST time ${chapter.chapterNo}`,
        location: `TEST location ${chapter.chapterNo}`,
        dependencyIds: [],
        evidence: { from: content.indexOf(quote), to: content.indexOf(quote) + quote.length, quote },
      })),
    });
    await commitPreparedChapter(chapter.id, version.id);
  }
  expect(totalChars).toBeGreaterThanOrEqual(1000000);
  expect((await pageCanonEvents(novel.id, 0)).total).toBe(2500);
  expect((await pageCanonEvents(novel.id, 0)).events).toHaveLength(50);
  expect((await pageCanonEvents(novel.id, 49)).events).toHaveLength(50);
  expect(await listWritingCards(novel.id,{confirmed:true,context:{chapterId:chapters[499]!.id,chapterNo:500}})).toHaveLength(1);
  const size = (
    await db.select<{ n: number }>('SELECT SUM(length(json)) AS n FROM story_bible_snapshots')
  )[0]!.n;
  expect(size).toBeLessThan(4_000_000);
  const bible = (await bibleBeforeChapter(novel.id, 501))!.bible;
  expect(bible.timeline).toHaveLength(2500);
  expect(bible.timeline[0]!.event).toBe('TEST evidence 1/0');
  const provider = {
    id: 'TEST',
    kind: 'openai_compatible' as const,
    model: 'TEST',
    caps: {
      contextWindow: 64000,
      maxOutputTokens: 6000,
      jsonMode: 'json_object' as const,
      cjkTokenRatio: 0.7,
    },
    async *stream() {
      throw new Error('TEST must not call model');
    },
  };
  let proseReads = 0;
  const select = db.select.bind(db);
  db.select = async <T>(q: string, p?: unknown[]) => {
    if (q.includes('FROM chapter_versions')) proseReads++;
    return select<T>(q, p);
  };
  const context = await buildChapterContextText(
    {
      novel,
      chapter: (await getChapter(chapters[499]!.id))!,
      doc: await buildStorylineDoc(novel.id, novel.premise, []),
      bible,
      snapshotId: null,
      chapters,
    },
    provider,
    2000,
  );
  expect(proseReads).toBeLessThanOrEqual(2);
  expect(context).toContain('TEST evidence 1/0');
  expect(context).not.toContain('TEST evidence 250/0');
  expect(context.length).toBeLessThan(30000);
  if (process.env.NATIVE_TEST_FIXTURE_PATH) {
    db.raw.exec('PRAGMA user_version=9');
    db.raw.prepare('VACUUM INTO ?').run(process.env.NATIVE_TEST_FIXTURE_PATH);
  }
  // TEST explicit invalidation leaves historical projection evidence intact.
  const first = chapters[0]!;
  await createVersion({ chapterId: first.id, source: 'user_edit', content: 'TEST edited opening' });
  await db.atomic(invalidateMemoryOperations(novel.id, 1));
  const snapshots = await listBibleSnapshots(novel.id);
  expect(snapshots.at(-1)!.bible.timeline).toHaveLength(2500);
  db.raw.close();
}, 120000);
