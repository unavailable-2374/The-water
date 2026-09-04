import { nanoid } from 'nanoid';
import { StoryBibleSchema, emptyBible, type StoryBible } from '@the-water/shared';
import { getDb, now, selectOne } from '../db';
import { parseJson } from '../mappers';

export interface BibleSnapshot { id: string; novelId: string; afterChapterNo: number; chapterVersionId: string | null; bible: StoryBible; createdAt: number }
interface Raw { id: string; novel_id: string; after_chapter_no: number; chapter_version_id: string | null; json: string; created_at: number }
const map = (r: Raw): BibleSnapshot => ({ id: r.id, novelId: r.novel_id, afterChapterNo: r.after_chapter_no, chapterVersionId: r.chapter_version_id, bible: parseJson(StoryBibleSchema, r.json, emptyBible()), createdAt: r.created_at });

export async function saveBible(novelId: string, afterChapterNo: number, bible: StoryBible, chapterVersionId: string | null = null): Promise<BibleSnapshot> {
  const id = nanoid();
  await getDb().execute('INSERT INTO story_bible_snapshots(id, novel_id, after_chapter_no, chapter_version_id, json, created_at) VALUES (?,?,?,?,?,?)', [id, novelId, afterChapterNo, chapterVersionId, JSON.stringify(bible), now()]);
  return (await selectOne<Raw>('SELECT * FROM story_bible_snapshots WHERE id = ?', [id]).then((r) => (r ? map(r) : null)))!;
}
/** Latest bible snapshot at or before `afterChapterNo` (falls back to empty). */
export async function bibleBeforeChapter(novelId: string, chapterNo: number): Promise<BibleSnapshot | null> {
  const r = await selectOne<Raw>('SELECT * FROM story_bible_snapshots WHERE novel_id = ? AND after_chapter_no <= ? ORDER BY after_chapter_no DESC, created_at DESC LIMIT 1', [novelId, chapterNo - 1]);
  return r ? map(r) : null;
}
export async function latestBible(novelId: string): Promise<BibleSnapshot | null> {
  const r = await selectOne<Raw>('SELECT * FROM story_bible_snapshots WHERE novel_id = ? ORDER BY after_chapter_no DESC, created_at DESC LIMIT 1', [novelId]);
  return r ? map(r) : null;
}
export async function listBibleSnapshots(novelId: string): Promise<BibleSnapshot[]> {
  return (await getDb().select<Raw>('SELECT * FROM story_bible_snapshots WHERE novel_id = ? ORDER BY after_chapter_no, created_at', [novelId])).map(map);
}
