import { nanoid } from 'nanoid';
import { countZh } from '@the-water/shared';
import { getDb, now, selectOne } from '../db';
import { num, parseJsonLoose } from '../mappers';

export type ChapterStatus = 'planned' | 'generating' | 'draft' | 'final' | 'stale';
export type VersionSource = 'generated' | 'rewritten' | 'topup' | 'trim' | 'user_edit' | 'imported';
export interface Chapter {
  id: string; novelId: string; chapterNo: number; title: string; goal: string; targetChars: number; povCharacterId: string | null;
  beatIds: string[]; endHook: string; currentVersionId: string | null; status: ChapterStatus; staleReasons: string[]; updatedAt: number;
}
export interface ChapterVersion {
  id: string; chapterId: string; versionNo: number; content: string; charCount: number; summary: string; source: VersionSource;
  storylineSnapshotId: string | null; jobStepId: string | null; model: string | null; usage: { inputTokens: number; outputTokens: number } | null; createdAt: number;
}
interface RawC { id: string; novel_id: string; chapter_no: number; title: string; goal: string; target_chars: number; pov_character_id: string | null; beat_ids: string; end_hook: string; current_version_id: string | null; status: string; stale_reasons: string; updated_at: number }
interface RawV { id: string; chapter_id: string; version_no: number; content: string; char_count: number; summary: string; source: string; storyline_snapshot_id: string | null; job_step_id: string | null; model: string | null; usage: string | null; created_at: number }
const mapC = (r: RawC): Chapter => ({
  id: r.id, novelId: r.novel_id, chapterNo: r.chapter_no, title: r.title, goal: r.goal, targetChars: num(r.target_chars), povCharacterId: r.pov_character_id,
  beatIds: parseJsonLoose(r.beat_ids, []), endHook: r.end_hook, currentVersionId: r.current_version_id, status: r.status as ChapterStatus,
  staleReasons: parseJsonLoose(r.stale_reasons, []), updatedAt: r.updated_at,
});
const mapV = (r: RawV): ChapterVersion => ({
  id: r.id, chapterId: r.chapter_id, versionNo: r.version_no, content: r.content, charCount: num(r.char_count), summary: r.summary, source: r.source as VersionSource,
  storylineSnapshotId: r.storyline_snapshot_id, jobStepId: r.job_step_id, model: r.model, usage: parseJsonLoose(r.usage, null), createdAt: r.created_at,
});

export async function listChapters(novelId: string): Promise<Chapter[]> {
  return (await getDb().select<RawC>('SELECT * FROM chapters WHERE novel_id = ? ORDER BY chapter_no', [novelId])).map(mapC);
}
export async function getChapter(id: string): Promise<Chapter | null> {
  const r = await selectOne<RawC>('SELECT * FROM chapters WHERE id = ?', [id]);
  return r ? mapC(r) : null;
}
export async function getChapterByNo(novelId: string, chapterNo: number): Promise<Chapter | null> {
  const r = await selectOne<RawC>('SELECT * FROM chapters WHERE novel_id = ? AND chapter_no = ?', [novelId, chapterNo]);
  return r ? mapC(r) : null;
}
export async function upsertChapterPlan(novelId: string, plan: { chapterNo: number; title?: string; goal?: string; targetChars?: number; povCharacterId?: string | null; beatIds?: string[]; endHook?: string }): Promise<Chapter> {
  const existing = await getChapterByNo(novelId, plan.chapterNo);
  if (existing) {
    await getDb().execute('UPDATE chapters SET title=?, goal=?, target_chars=?, pov_character_id=?, beat_ids=?, end_hook=?, updated_at=? WHERE id=?', [
      plan.title ?? existing.title, plan.goal ?? existing.goal, plan.targetChars ?? existing.targetChars, plan.povCharacterId === undefined ? existing.povCharacterId : plan.povCharacterId,
      JSON.stringify(plan.beatIds ?? existing.beatIds), plan.endHook ?? existing.endHook, now(), existing.id,
    ]);
    return (await getChapter(existing.id))!;
  }
  const id = nanoid();
  await getDb().execute(
    'INSERT INTO chapters(id, novel_id, chapter_no, title, goal, target_chars, pov_character_id, beat_ids, end_hook, status, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [id, novelId, plan.chapterNo, plan.title ?? '', plan.goal ?? '', plan.targetChars ?? 0, plan.povCharacterId ?? null, JSON.stringify(plan.beatIds ?? []), plan.endHook ?? '', 'planned', now()],
  );
  return (await getChapter(id))!;
}
export async function deleteChaptersFrom(novelId: string, fromChapterNo: number): Promise<void> {
  await getDb().execute('DELETE FROM chapters WHERE novel_id = ? AND chapter_no >= ?', [novelId, fromChapterNo]);
}
export async function setChapterStatus(id: string, status: ChapterStatus, staleReasons?: string[]): Promise<void> {
  if (staleReasons) await getDb().execute('UPDATE chapters SET status = ?, stale_reasons = ?, updated_at = ? WHERE id = ?', [status, JSON.stringify(staleReasons), now(), id]);
  else await getDb().execute('UPDATE chapters SET status = ?, updated_at = ? WHERE id = ?', [status, now(), id]);
}
export async function markStaleFrom(novelId: string, fromChapterNo: number, reason: string): Promise<void> {
  const rows = await getDb().select<RawC>("SELECT * FROM chapters WHERE novel_id = ? AND chapter_no >= ? AND status IN ('draft','final','stale')", [novelId, fromChapterNo]);
  for (const r of rows) {
    const reasons = Array.from(new Set([...parseJsonLoose<string[]>(r.stale_reasons, []), reason]));
    await getDb().execute('UPDATE chapters SET status = ?, stale_reasons = ?, updated_at = ? WHERE id = ?', ['stale', JSON.stringify(reasons), now(), r.id]);
  }
}
export async function setChapterTarget(id: string, targetChars: number): Promise<void> {
  await getDb().execute('UPDATE chapters SET target_chars = ?, updated_at = ? WHERE id = ?', [targetChars, now(), id]);
}

export async function listVersions(chapterId: string): Promise<ChapterVersion[]> {
  return (await getDb().select<RawV>('SELECT * FROM chapter_versions WHERE chapter_id = ? ORDER BY version_no DESC', [chapterId])).map(mapV);
}
export async function getVersion(id: string): Promise<ChapterVersion | null> {
  const r = await selectOne<RawV>('SELECT * FROM chapter_versions WHERE id = ?', [id]);
  return r ? mapV(r) : null;
}
export async function getCurrentVersion(chapterId: string): Promise<ChapterVersion | null> {
  const c = await getChapter(chapterId);
  if (!c?.currentVersionId) return null;
  return getVersion(c.currentVersionId);
}
export async function findVersionByStep(chapterId: string, jobStepId: string): Promise<ChapterVersion | null> {
  const r = await selectOne<RawV>('SELECT * FROM chapter_versions WHERE chapter_id = ? AND job_step_id = ? ORDER BY version_no DESC LIMIT 1', [chapterId, jobStepId]);
  return r ? mapV(r) : null;
}
/** Create a new version and make it current. Chapter status becomes 'draft' unless specified. */
export async function createVersion(input: { chapterId: string; content: string; source: VersionSource; summary?: string; storylineSnapshotId?: string | null; jobStepId?: string | null; model?: string | null; usage?: ChapterVersion['usage']; status?: ChapterStatus }): Promise<ChapterVersion> {
  const db = getDb();
  const last = await selectOne<{ m: number | null }>('SELECT MAX(version_no) AS m FROM chapter_versions WHERE chapter_id = ?', [input.chapterId]);
  const versionNo = (last?.m ?? 0) + 1;
  const id = nanoid();
  await db.execute(
    'INSERT INTO chapter_versions(id, chapter_id, version_no, content, char_count, summary, source, storyline_snapshot_id, job_step_id, model, usage, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, input.chapterId, versionNo, input.content, countZh(input.content), input.summary ?? '', input.source, input.storylineSnapshotId ?? null, input.jobStepId ?? null, input.model ?? null, input.usage ? JSON.stringify(input.usage) : null, now()],
  );
  await db.execute('UPDATE chapters SET current_version_id = ?, status = ?, stale_reasons = ?, updated_at = ? WHERE id = ?', [id, input.status ?? 'draft', '[]', now(), input.chapterId]);
  return (await getVersion(id))!;
}
export async function updateVersionSummary(id: string, summary: string): Promise<void> {
  await getDb().execute('UPDATE chapter_versions SET summary = ? WHERE id = ?', [summary, id]);
}
export async function restoreVersion(chapterId: string, versionId: string): Promise<void> {
  await getDb().execute('UPDATE chapters SET current_version_id = ?, status = ?, updated_at = ? WHERE id = ?', [versionId, 'draft', now(), chapterId]);
}
/** Current versions of all chapters of a novel in order (content included). */
export async function listCurrentVersions(novelId: string): Promise<Array<{ chapter: Chapter; version: ChapterVersion | null }>> {
  const chapters = await listChapters(novelId);
  const out: Array<{ chapter: Chapter; version: ChapterVersion | null }> = [];
  for (const c of chapters) out.push({ chapter: c, version: c.currentVersionId ? await getVersion(c.currentVersionId) : null });
  return out;
}
/** 一次聚合拿到所有小说的字数（书架页避免每本一次查询）。缺席的小说按 0 计。 */
export async function novelCharCounts(): Promise<Record<string, number>> {
  const rows = await getDb().select<{ novel_id: string; s: number | null }>(
    'SELECT c.novel_id AS novel_id, SUM(v.char_count) AS s FROM chapters c JOIN chapter_versions v ON v.id = c.current_version_id GROUP BY c.novel_id',
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.novel_id] = num(r.s);
  return out;
}
export async function novelCharCount(novelId: string): Promise<number> {
  const r = await selectOne<{ s: number | null }>(
    'SELECT SUM(v.char_count) AS s FROM chapters c JOIN chapter_versions v ON v.id = c.current_version_id WHERE c.novel_id = ?', [novelId],
  );
  return r?.s ?? 0;
}
