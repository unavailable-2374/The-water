import { nanoid } from 'nanoid';
import { countZh } from '@the-water/shared';
import { getDb, now, selectOne } from '../db';
import { num, parseJsonLoose } from '../mappers';
import {
  DEFAULT_KEEP_VERSIONS, planRewriteResolution, selectVersionsToPrune, stateForNewVersion, versionLock,
  type PrunableVersion, type RewriteAction, type RewriteSessionView, type VersionState,
} from '@/novel/versionPolicy';

export type ChapterStatus = 'planned' | 'generating' | 'draft' | 'final' | 'stale';
export type VersionSource = 'generated' | 'rewritten' | 'topup' | 'trim' | 'user_edit' | 'imported';
export type { VersionState };
export interface Chapter {
  id: string; novelId: string; chapterNo: number; title: string; goal: string; targetChars: number; povCharacterId: string | null;
  beatIds: string[]; endHook: string; currentVersionId: string | null; status: ChapterStatus; staleReasons: string[]; updatedAt: number;
  /** 改写会话（§2.2）：改写前的版本与章节状态，三者同时为空表示没有待采纳的改写。 */
  rewriteBaselineVersionId: string | null; rewriteBaselineStatus: ChapterStatus | null; rewriteJobId: string | null;
}
export interface ChapterVersion {
  id: string; chapterId: string; versionNo: number; content: string; charCount: number; summary: string; source: VersionSource;
  storylineSnapshotId: string | null; jobStepId: string | null; model: string | null; usage: { inputTokens: number; outputTokens: number } | null; createdAt: number;
  /** 取舍状态：accepted 常规 / pending 待采纳 / discarded 已丢弃。 */
  state: VersionState;
  /** pending 版本替换掉的那一版（丢弃时回到它）。 */
  baselineVersionId: string | null;
  /** 钉住的版本不参与清理。 */
  pinned: boolean;
  /** 非空表示这一版还在一次编辑会话里，自动保存只更新它。 */
  sessionId: string | null;
  updatedAt: number;
}
interface RawC { id: string; novel_id: string; chapter_no: number; title: string; goal: string; target_chars: number; pov_character_id: string | null; beat_ids: string; end_hook: string; current_version_id: string | null; status: string; stale_reasons: string; updated_at: number; rewrite_baseline_version_id: string | null; rewrite_baseline_status: string | null; rewrite_job_id: string | null }
interface RawV { id: string; chapter_id: string; version_no: number; content: string; char_count: number; summary: string; source: string; storyline_snapshot_id: string | null; job_step_id: string | null; model: string | null; usage: string | null; created_at: number; state: string | null; baseline_version_id: string | null; pinned: number | null; session_id: string | null; updated_at: number | null }
const mapC = (r: RawC): Chapter => ({
  id: r.id, novelId: r.novel_id, chapterNo: r.chapter_no, title: r.title, goal: r.goal, targetChars: num(r.target_chars), povCharacterId: r.pov_character_id,
  beatIds: parseJsonLoose(r.beat_ids, []), endHook: r.end_hook, currentVersionId: r.current_version_id, status: r.status as ChapterStatus,
  staleReasons: parseJsonLoose(r.stale_reasons, []), updatedAt: r.updated_at,
  rewriteBaselineVersionId: r.rewrite_baseline_version_id, rewriteBaselineStatus: (r.rewrite_baseline_status as ChapterStatus | null) ?? null, rewriteJobId: r.rewrite_job_id,
});
const mapV = (r: RawV): ChapterVersion => ({
  id: r.id, chapterId: r.chapter_id, versionNo: r.version_no, content: r.content, charCount: num(r.char_count), summary: r.summary, source: r.source as VersionSource,
  storylineSnapshotId: r.storyline_snapshot_id, jobStepId: r.job_step_id, model: r.model, usage: parseJsonLoose(r.usage, null), createdAt: r.created_at,
  state: (r.state as VersionState | null) ?? 'accepted', baselineVersionId: r.baseline_version_id, pinned: !!r.pinned, sessionId: r.session_id, updatedAt: r.updated_at ?? r.created_at,
});
const sessionView = (c: Chapter): RewriteSessionView => ({
  baselineVersionId: c.rewriteBaselineVersionId, baselineStatus: c.rewriteBaselineStatus, currentVersionId: c.currentVersionId, status: c.status,
});
const prunable = (v: ChapterVersion): PrunableVersion => ({ id: v.id, versionNo: v.versionNo, state: v.state, pinned: v.pinned, sessionId: v.sessionId });

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
/**
 * Create a new version and make it current. Chapter status becomes 'draft' unless specified.
 *
 * 章节上开着改写会话时，新版本一律先落「待采纳」（§2.2 第 1 条）并记下它替换掉的
 * 那一版；**仍然置为 current**，因为 adjust_length / style_check / summarize 都读
 * current_version_id，不置 current 后面几步就会拿着旧正文干活。
 */
export async function createVersion(input: { chapterId: string; content: string; source: VersionSource; summary?: string; storylineSnapshotId?: string | null; jobStepId?: string | null; model?: string | null; usage?: ChapterVersion['usage']; status?: ChapterStatus; sessionId?: string | null }): Promise<ChapterVersion> {
  const db = getDb();
  const chapter = await getChapter(input.chapterId);
  const last = await selectOne<{ m: number | null }>('SELECT MAX(version_no) AS m FROM chapter_versions WHERE chapter_id = ?', [input.chapterId]);
  const versionNo = (last?.m ?? 0) + 1;
  const id = nanoid();
  const state = chapter ? stateForNewVersion(sessionView(chapter)) : 'accepted';
  const t = now();
  await db.execute(
    'INSERT INTO chapter_versions(id, chapter_id, version_no, content, char_count, summary, source, storyline_snapshot_id, job_step_id, model, usage, created_at, state, baseline_version_id, pinned, session_id, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)',
    [id, input.chapterId, versionNo, input.content, countZh(input.content), input.summary ?? '', input.source, input.storylineSnapshotId ?? null, input.jobStepId ?? null, input.model ?? null, input.usage ? JSON.stringify(input.usage) : null, t,
      state, state === 'pending' ? chapter!.rewriteBaselineVersionId : null, input.sessionId ?? null, t],
  );
  await db.execute('UPDATE chapters SET current_version_id = ?, status = ?, stale_reasons = ?, updated_at = ? WHERE id = ?', [id, input.status ?? 'draft', '[]', t, input.chapterId]);
  return (await getVersion(id))!;
}
export async function updateVersionSummary(id: string, summary: string): Promise<void> {
  await getDb().execute('UPDATE chapter_versions SET summary = ? WHERE id = ?', [summary, id]);
}
export async function restoreVersion(chapterId: string, versionId: string): Promise<void> {
  // 换回一稿丢弃过的版本，就等于作者改了主意，它不该再顶着「已丢弃」。
  await getDb().execute("UPDATE chapter_versions SET state = 'accepted' WHERE id = ? AND state = 'discarded'", [versionId]);
  await getDb().execute('UPDATE chapters SET current_version_id = ?, status = ?, updated_at = ? WHERE id = ?', [versionId, 'draft', now(), chapterId]);
}

// ---------------------------------------------------------------------------
// 会话级自动保存（§2.2 第 3 条）
// ---------------------------------------------------------------------------

/**
 * 手动编辑的自动保存：同一次编辑会话只占一个版本行，反复覆盖它。
 * 原来每 2 秒空闲就 createVersion 一次，改几分钟能攒出几十稿。
 */
export async function saveSessionEdit(input: { chapterId: string; sessionId: string; content: string; summary?: string; status?: ChapterStatus }): Promise<ChapterVersion> {
  const open = await selectOne<RawV>('SELECT * FROM chapter_versions WHERE chapter_id = ? AND session_id = ? ORDER BY version_no DESC LIMIT 1', [input.chapterId, input.sessionId]);
  if (!open) {
    return createVersion({ chapterId: input.chapterId, content: input.content, source: 'user_edit', summary: input.summary, status: input.status, sessionId: input.sessionId });
  }
  const t = now();
  await getDb().execute('UPDATE chapter_versions SET content = ?, char_count = ?, updated_at = ? WHERE id = ?', [input.content, countZh(input.content), t, open.id]);
  await getDb().execute('UPDATE chapters SET current_version_id = ?, status = ?, stale_reasons = ?, updated_at = ? WHERE id = ?', [open.id, input.status ?? 'draft', '[]', t, input.chapterId]);
  return (await getVersion(open.id))!;
}
/** 封版：这一行不再接受覆盖，之后的编辑会另起一稿。 */
export async function sealVersionSession(sessionId: string): Promise<void> {
  await getDb().execute('UPDATE chapter_versions SET session_id = NULL WHERE session_id = ?', [sessionId]);
}
/** 关掉这一章所有开着的会话（进编辑器时先做一次，清掉上次崩溃留下的）。 */
export async function sealChapterSessions(chapterId: string): Promise<void> {
  await getDb().execute('UPDATE chapter_versions SET session_id = NULL WHERE chapter_id = ? AND session_id IS NOT NULL', [chapterId]);
}

// ---------------------------------------------------------------------------
// 待采纳的改写（§2.2 第 1、4 条）
// ---------------------------------------------------------------------------

/** 改写开工前给这些章节开会话，记下改写前的版本与状态；没有正文的章节跳过。 */
export async function beginRewriteSession(chapterIds: readonly string[], jobId: string | null = null): Promise<number> {
  let opened = 0;
  for (const chapterId of chapterIds) {
    const c = await getChapter(chapterId);
    if (!c?.currentVersionId || c.rewriteBaselineVersionId) continue;
    await getDb().execute('UPDATE chapters SET rewrite_baseline_version_id = ?, rewrite_baseline_status = ?, rewrite_job_id = ?, updated_at = ? WHERE id = ?', [c.currentVersionId, c.status, jobId, now(), chapterId]);
    opened++;
  }
  return opened;
}

export interface PendingRewrite {
  chapter: Chapter;
  /** 改写前的那一版。 */
  baseline: ChapterVersion | null;
  /** 改写产出里最新的一版（就是当前正文）。 */
  latest: ChapterVersion | null;
  /** 本次会话产出的全部版本，新到旧。 */
  produced: ChapterVersion[];
}

async function pendingOf(chapter: Chapter): Promise<PendingRewrite> {
  const produced = (await getDb().select<RawV>("SELECT * FROM chapter_versions WHERE chapter_id = ? AND state = 'pending' ORDER BY version_no DESC", [chapter.id])).map(mapV);
  return {
    chapter,
    baseline: chapter.rewriteBaselineVersionId ? await getVersion(chapter.rewriteBaselineVersionId) : null,
    latest: (chapter.currentVersionId ? produced.find((v) => v.id === chapter.currentVersionId) : null) ?? produced[0] ?? null,
    produced,
  };
}

/** 这本书里等着作者取舍的章节，按章号排。 */
export async function listPendingRewrites(novelId: string): Promise<PendingRewrite[]> {
  const rows = await getDb().select<RawC>('SELECT * FROM chapters WHERE novel_id = ? AND rewrite_baseline_version_id IS NOT NULL ORDER BY chapter_no', [novelId]);
  const out: PendingRewrite[] = [];
  for (const r of rows) out.push(await pendingOf(mapC(r)));
  return out;
}
export async function getPendingRewrite(chapterId: string): Promise<PendingRewrite | null> {
  const c = await getChapter(chapterId);
  return c?.rewriteBaselineVersionId ? pendingOf(c) : null;
}

/** 采纳 / 丢弃一章的改写结果；丢弃就是「撤销这次改写」，回到改写前的那一版。 */
export async function resolveRewrite(chapterId: string, action: RewriteAction): Promise<void> {
  const c = await getChapter(chapterId);
  if (!c?.rewriteBaselineVersionId) return;
  const plan = planRewriteResolution(sessionView(c), action);
  const db = getDb();
  await db.execute("UPDATE chapter_versions SET state = ? WHERE chapter_id = ? AND state = 'pending'", [plan.pendingBecomes, chapterId]);
  await db.execute('UPDATE chapters SET current_version_id = ?, status = ?, rewrite_baseline_version_id = NULL, rewrite_baseline_status = NULL, rewrite_job_id = NULL, updated_at = ? WHERE id = ?', [plan.currentVersionId, plan.status, now(), chapterId]);
}

/** 整本书一起处理（「全部采纳」/「撤销这次改写」）。返回处理了几章。 */
export async function resolveAllRewrites(novelId: string, action: RewriteAction): Promise<number> {
  const pending = await listPendingRewrites(novelId);
  for (const p of pending) await resolveRewrite(p.chapter.id, action);
  return pending.length;
}

// ---------------------------------------------------------------------------
// 版本清理（§2.2 第 2 条）
// ---------------------------------------------------------------------------

export async function setVersionPinned(id: string, pinned: boolean): Promise<void> {
  await getDb().execute('UPDATE chapter_versions SET pinned = ? WHERE id = ?', [pinned ? 1 : 0, id]);
}

/** 删一个版本；当前版本 / 钉住的 / 待采纳的 / 正在编辑的 / 改写基线都删不了。 */
export async function deleteVersion(id: string): Promise<void> {
  const v = await getVersion(id);
  if (!v) return;
  const c = await getChapter(v.chapterId);
  const reason = versionLock(prunable(v), { currentVersionId: c?.currentVersionId ?? null, baselineVersionId: c?.rewriteBaselineVersionId ?? null });
  if (reason) throw new Error(reason);
  await getDb().execute('DELETE FROM chapter_versions WHERE id = ?', [id]);
}

/** 按「保留最近 N 稿」清理一章；返回删掉的稿数。 */
export async function pruneVersions(chapterId: string, keep: number = DEFAULT_KEEP_VERSIONS): Promise<number> {
  const c = await getChapter(chapterId);
  if (!c) return 0;
  const versions = await listVersions(chapterId);
  const ids = selectVersionsToPrune({ versions: versions.map(prunable), keep, currentVersionId: c.currentVersionId, baselineVersionId: c.rewriteBaselineVersionId });
  for (const id of ids) await getDb().execute('DELETE FROM chapter_versions WHERE id = ?', [id]);
  return ids.length;
}

/** 界面上先问一句「会删掉几稿」用的预演。 */
export async function previewPrune(chapterId: string, keep: number = DEFAULT_KEEP_VERSIONS): Promise<number> {
  const c = await getChapter(chapterId);
  if (!c) return 0;
  const versions = await listVersions(chapterId);
  return selectVersionsToPrune({ versions: versions.map(prunable), keep, currentVersionId: c.currentVersionId, baselineVersionId: c.rewriteBaselineVersionId }).length;
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
