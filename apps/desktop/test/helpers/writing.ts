/** TEST ONLY: explicit fixture reviews/extractions, never evidence of model quality. */
import { ChapterReviewJsonSchema, saveReview } from '@/db/repos/reviewsRepo';
import { getChapter, getVersion } from '@/db/repos/chaptersRepo';
import { chapterDependencies, stageExtraction, saveWritingCard } from '@/db/repos/writingRepo';
export async function stageTestChapter(chapterId: string) {
  const chapter = (await getChapter(chapterId))!;
  const version = (await getVersion(chapter.currentVersionId!))!;
  const deps = await chapterDependencies(chapter.novelId, chapter.chapterNo);
  const review = await saveReview({
    novelId: chapter.novelId,
    chapterId,
    chapterVersionId: version.id,
    styleScore: 100,
    oocCount: 0,
    verdict: 'pass',
    report: ChapterReviewJsonSchema.parse({ narrative: [] }),
    dependencyHash: deps.hash,
  });
  await stageExtraction(chapterId, version.id, review.id, deps.hash, { summary: 'TEST summary', events: [] });
  return version;
}
export async function testScene(novelId: string, chapterId: string, characterId: string | null = null) {
  return saveWritingCard(
    novelId,
    {
      kind: 'scene',
      data: {
        title: 'TEST scene',
        volumeId: null,
        povCharacterId: characterId,
        time: 'TEST time',
        location: 'TEST place',
        characterIds: characterId ? [characterId] : [],
        goal: 'TEST goal',
        obstacle: 'TEST obstacle',
        turn: 'TEST turn',
        outcome: 'TEST outcome',
        targetChars: 250,
        dependencyIds: [],
        threadIds: [],
      },
    },
    { chapterId, confirmed: true },
  );
}

/** TEST / SIMULATED reviewer verdict for deterministic orchestration fixtures, never a reader-quality result. */
export const testReadyStory = () => ({readingFocus:'TEST scripted reading focus',changes:[],expectations:[],nextInterest:'TEST scripted next step',verdict:'ready' as const,reason:'TEST / SIMULATED reviewer result; not real model or reader evidence'});

/** TEST / SIMULATED length verdict; not evidence of model quality. */
export const testReadyLengthReview = () => ({action:'keep' as const,reason:'TEST / SIMULATED complete scene; no quota-based adjustment',actions:[]});
