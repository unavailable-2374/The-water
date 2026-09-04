import { nanoid } from 'nanoid';
import { NovelOriginSchema, type NovelOrigin } from '@the-water/shared';
import { getDb, now, selectOne } from '../db';
import { num, parseJson, parseJsonLoose } from '../mappers';
import { NovelRequirementsSchema, defaultRequirements, type NovelRequirements } from '@/novel/types';

export type NovelStatus = 'draft' | 'planning' | 'generating' | 'writing' | 'complete';
export interface RemoteState {
  serverUrl: string; novelId: string; currentVersionId: string | null; chapterHashes: string[]; storylineHash: string | null;
  draftVersionId: string | null; publishAttemptId: string | null; publishedAt: string | null;
}
export interface NovelMeta { logline: string; themes: string[]; outlineDone: boolean; tableDone: boolean }
export const defaultMeta = (): NovelMeta => ({ logline: '', themes: [], outlineDone: false, tableDone: false });
export interface Novel {
  id: string; title: string; premise: string; requirements: NovelRequirements; targetChars: number; status: NovelStatus;
  coverPath: string | null; origin: NovelOrigin | null; remote: RemoteState | null; meta: NovelMeta; createdAt: number; updatedAt: number;
}
/** 回收站里的小说：多带一个删除时间，用来算保留期。 */
export interface TrashedNovel extends Novel { deletedAt: number }
interface Raw { id: string; title: string; premise: string; requirements: string; target_chars: number; status: string; cover_path: string | null; origin: string | null; remote: string | null; meta: string; created_at: number; updated_at: number; deleted_at: number | null }
const map = (r: Raw): Novel => ({
  id: r.id, title: r.title, premise: r.premise, requirements: parseJson(NovelRequirementsSchema, r.requirements, defaultRequirements()),
  targetChars: num(r.target_chars), status: r.status as NovelStatus, coverPath: r.cover_path,
  origin: r.origin ? parseJson(NovelOriginSchema, r.origin, null as unknown as NovelOrigin) : null,
  remote: parseJsonLoose<RemoteState | null>(r.remote, null), meta: { ...defaultMeta(), ...parseJsonLoose<Partial<NovelMeta>>(r.meta, {}) }, createdAt: r.created_at, updatedAt: r.updated_at,
});

export async function listNovels(): Promise<Novel[]> {
  return (await getDb().select<Raw>('SELECT * FROM novels WHERE deleted_at IS NULL ORDER BY updated_at DESC')).map(map);
}
export async function getNovel(id: string): Promise<Novel | null> {
  const r = await selectOne<Raw>('SELECT * FROM novels WHERE id = ? AND deleted_at IS NULL', [id]);
  return r ? map(r) : null;
}
export async function createNovel(input: { title: string; premise: string; requirements: NovelRequirements; targetChars: number; status?: NovelStatus; origin?: NovelOrigin | null }): Promise<Novel> {
  const id = nanoid();
  const t = now();
  await getDb().execute(
    'INSERT INTO novels(id, title, premise, requirements, target_chars, status, origin, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, input.title, input.premise, JSON.stringify(input.requirements), input.targetChars, input.status ?? 'draft', input.origin ? JSON.stringify(input.origin) : null, t, t],
  );
  return (await getNovel(id))!;
}
export async function updateNovel(id: string, patch: Partial<Pick<Novel, 'title' | 'premise' | 'requirements' | 'targetChars' | 'status' | 'coverPath' | 'remote' | 'origin' | 'meta'>>): Promise<Novel | null> {
  const cur = await getNovel(id);
  if (!cur) return null;
  const n = { ...cur, ...patch };
  await getDb().execute(
    'UPDATE novels SET title=?, premise=?, requirements=?, target_chars=?, status=?, cover_path=?, origin=?, remote=?, meta=?, updated_at=? WHERE id=?',
    [n.title, n.premise, JSON.stringify(n.requirements), n.targetChars, n.status, n.coverPath, n.origin ? JSON.stringify(n.origin) : null, n.remote ? JSON.stringify(n.remote) : null, JSON.stringify(n.meta), now(), id],
  );
  return getNovel(id);
}
export async function touchNovel(id: string): Promise<void> {
  await getDb().execute('UPDATE novels SET updated_at = ? WHERE id = ?', [now(), id]);
}
/** 删除 = 丢进回收站（软删）。章节 / 版本 / 故事线都原样留着，恢复后完好如初。 */
export async function deleteNovel(id: string): Promise<void> {
  await getDb().execute('UPDATE novels SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', [now(), id]);
}
/** 从回收站捞回来。 */
export async function restoreNovel(id: string): Promise<void> {
  await getDb().execute('UPDATE novels SET deleted_at = NULL, updated_at = ? WHERE id = ?', [now(), id]);
}
/** 真正抹掉（级联删章节 / 版本 / 故事线），只在「立即永久删除」和过期清理时调用。 */
export async function purgeNovel(id: string): Promise<void> {
  await getDb().execute('DELETE FROM novels WHERE id = ?', [id]);
}
export async function listTrashedNovels(): Promise<TrashedNovel[]> {
  const rows = await getDb().select<Raw>('SELECT * FROM novels WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC');
  return rows.map((r) => ({ ...map(r), deletedAt: num(r.deleted_at) }));
}
/** 删除时间早于 cutoff 的小说 id，供启动清理使用。 */
export async function listNovelIdsDeletedBefore(cutoff: number): Promise<string[]> {
  const rows = await getDb().select<{ id: string }>('SELECT id FROM novels WHERE deleted_at IS NOT NULL AND deleted_at < ?', [cutoff]);
  return rows.map((r) => r.id);
}
