import { nanoid } from 'nanoid';
import { CanonEventSchema, StoryBibleSchema, emptyBible, type StoryBible } from '@the-water/shared';
import { getDb, now, selectOne } from '../db';
import { z } from 'zod';
import { projectEvents } from './writingRepo';

export interface BibleSnapshot { id: string; novelId: string; afterChapterNo: number; chapterVersionId: string | null; bible: StoryBible; createdAt: number }
interface Raw { id: string; novel_id: string; after_chapter_no: number; chapter_version_id: string | null; json: string; created_at: number }
const CanonProjection = z.object({ projection: z.literal('canon'), commitIds: z.array(z.string()).max(500) });
async function map(r: Raw): Promise<BibleSnapshot> {
  const stored: unknown = JSON.parse(r.json);
  const projection = CanonProjection.safeParse(stored);
  let bible: StoryBible;
  if (projection.success) {
    const ids = projection.data.commitIds;
    const commits = ids.length ? await getDb().select<{ id: string }>(`SELECT id FROM chapter_commits WHERE chapter_id IN (SELECT id FROM chapters WHERE novel_id=?) AND id IN (${ids.map(()=>'?').join(',')})`, [r.novel_id, ...ids]) : [];
    if (commits.length !== new Set(ids).size) throw new Error('故事记忆引用的提交记录缺失，请从备份恢复');
    const events = ids.length ? await getDb().select<{ json: string; chapter_no: number }>(`SELECT json,chapter_no FROM canon_events WHERE novel_id=? AND commit_id IN (${ids.map(()=>'?').join(',')}) ORDER BY chapter_no,event_index,id`, [r.novel_id,...ids]) : [];
    // Historical snapshots deliberately retain invalidated event generations.
    bible = projectEvents(emptyBible(), events.map(e=>({...CanonEventSchema.parse(JSON.parse(e.json)),chapterNo:e.chapter_no})), r.after_chapter_no);
  } else bible = StoryBibleSchema.parse(stored);
  return { id: r.id, novelId: r.novel_id, afterChapterNo: r.after_chapter_no, chapterVersionId: r.chapter_version_id, bible, createdAt: r.created_at };
}

export async function saveBible(novelId: string, afterChapterNo: number, bible: StoryBible, chapterVersionId: string | null = null): Promise<BibleSnapshot> {
  const id = nanoid();
  await getDb().execute('INSERT INTO story_bible_snapshots(id, novel_id, after_chapter_no, chapter_version_id, json, created_at) VALUES (?,?,?,?,?,?)', [id, novelId, afterChapterNo, chapterVersionId, JSON.stringify(bible), now()]);
  return map((await selectOne<Raw>('SELECT * FROM story_bible_snapshots WHERE id = ?', [id]))!);
}
/** Latest bible snapshot at or before `afterChapterNo` (falls back to empty). */
export async function bibleBeforeChapter(novelId: string, chapterNo: number): Promise<BibleSnapshot | null> {
  const r = await selectOne<Raw>('SELECT * FROM story_bible_snapshots WHERE novel_id = ? AND valid=1 AND after_chapter_no <= ? ORDER BY after_chapter_no DESC, created_at DESC LIMIT 1', [novelId, chapterNo - 1]);
  return r ? map(r) : null;
}
export async function latestBible(novelId: string): Promise<BibleSnapshot | null> {
  const r = await selectOne<Raw>('SELECT * FROM story_bible_snapshots WHERE novel_id = ? AND valid=1 ORDER BY after_chapter_no DESC, created_at DESC LIMIT 1', [novelId]);
  return r ? map(r) : null;
}
export async function listBibleSnapshots(novelId: string): Promise<BibleSnapshot[]> {
  return Promise.all((await getDb().select<Raw>('SELECT * FROM story_bible_snapshots WHERE novel_id = ? ORDER BY after_chapter_no, created_at', [novelId])).map(map));
}
