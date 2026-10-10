import { writeAtomic, writeStatement, type AtomicWriter } from '../db';
import { nanoid } from 'nanoid';
import { countZh, sha256Hex, TextProposalSchema } from '@the-water/shared';
import { getDb, now, selectOne, type AtomicOperation } from '../db';
import { num, parseJsonLoose } from '../mappers';
import {
  DEFAULT_KEEP_VERSIONS, selectVersionsToPrune, versionLock,
  type PrunableVersion, type RewriteAction, type VersionState,
} from '@/novel/versionPolicy';

export type ChapterStatus = 'planned' | 'generating' | 'draft' | 'final' | 'stale';
export type VersionSource = 'generated' | 'rewritten' | 'topup' | 'trim' | 'user_edit' | 'imported';
export type { VersionState };
export interface Chapter {
  id: string; novelId: string; chapterNo: number; title: string; goal: string; targetChars: number; povCharacterId: string | null;
  committedVersionId: string | null; memoryStatus: 'missing' | 'valid' | 'stale' | 'legacy';
  beatIds: string[]; endHook: string; currentVersionId: string | null; status: ChapterStatus; staleReasons: string[]; updatedAt: number;
  /** 改写会话（§2.2）：改写前的版本与章节状态，三者同时为空表示没有待采纳的改写。 */
  rewriteBaselineVersionId: string | null; rewriteBaselineStatus: ChapterStatus | null; rewriteJobId: string | null;
}
export interface ChapterVersion {
  id: string; chapterId: string; versionNo: number; content: string; charCount: number; summary: string; source: VersionSource;
  storylineSnapshotId: string | null; jobStepId: string | null; model: string | null; usage: { inputTokens: number; outputTokens: number } | null; createdAt: number;
  /** 取舍状态：accepted 常规 / pending 待采纳 / discarded 已丢弃。 */
  state: VersionState;
  contentHash: string; committedAt: number | null;
  /** pending 版本替换掉的那一版（丢弃时回到它）。 */
  baselineVersionId: string | null;
  /** 钉住的版本不参与清理。 */
  pinned: boolean;
  /** 非空表示这一版还在一次编辑会话里，自动保存只更新它。 */
  sessionId: string | null;
  updatedAt: number;
}
interface RawC { committed_version_id: string | null; memory_status: Chapter['memoryStatus']; id: string; novel_id: string; chapter_no: number; title: string; goal: string; target_chars: number; pov_character_id: string | null; beat_ids: string; end_hook: string; current_version_id: string | null; status: string; stale_reasons: string; updated_at: number; rewrite_baseline_version_id: string | null; rewrite_baseline_status: string | null; rewrite_job_id: string | null }
interface RawV { content_hash: string; committed_at: number | null; id: string; chapter_id: string; version_no: number; content: string; char_count: number; summary: string; source: string; storyline_snapshot_id: string | null; job_step_id: string | null; model: string | null; usage: string | null; created_at: number; state: string | null; baseline_version_id: string | null; pinned: number | null; session_id: string | null; updated_at: number | null }
const mapC = (r: RawC): Chapter => ({
  committedVersionId: r.committed_version_id, memoryStatus: r.memory_status,
  id: r.id, novelId: r.novel_id, chapterNo: r.chapter_no, title: r.title, goal: r.goal, targetChars: num(r.target_chars), povCharacterId: r.pov_character_id,
  beatIds: parseJsonLoose(r.beat_ids, []), endHook: r.end_hook, currentVersionId: r.current_version_id, status: r.status as ChapterStatus,
  staleReasons: parseJsonLoose(r.stale_reasons, []), updatedAt: r.updated_at,
  rewriteBaselineVersionId: r.rewrite_baseline_version_id, rewriteBaselineStatus: (r.rewrite_baseline_status as ChapterStatus | null) ?? null, rewriteJobId: r.rewrite_job_id,
});
const mapV = (r: RawV): ChapterVersion => ({
  contentHash: r.content_hash, committedAt: r.committed_at,
  id: r.id, chapterId: r.chapter_id, versionNo: r.version_no, content: r.content, charCount: num(r.char_count), summary: r.summary, source: r.source as VersionSource,
  storylineSnapshotId: r.storyline_snapshot_id, jobStepId: r.job_step_id, model: r.model, usage: parseJsonLoose(r.usage, null), createdAt: r.created_at,
  state: (r.state as VersionState | null) ?? 'accepted', baselineVersionId: r.baseline_version_id, pinned: !!r.pinned, sessionId: r.session_id, updatedAt: r.updated_at ?? r.created_at,
});
const prunable = (v: ChapterVersion): PrunableVersion => ({ id: v.id, versionNo: v.versionNo, state: v.state, pinned: v.pinned || v.committedAt !== null, sessionId: v.sessionId });

export async function listChapters(novelId: string): Promise<Chapter[]> {
  return (await getDb().select<RawC>('SELECT * FROM chapters WHERE novel_id = ? AND archived_at IS NULL ORDER BY chapter_no', [novelId])).map(mapC);
}
export async function getChapter(id: string): Promise<Chapter | null> {
  const r = await selectOne<RawC>('SELECT * FROM chapters WHERE id = ?', [id]);
  return r ? mapC(r) : null;
}
export async function getChapterByNo(novelId: string, chapterNo: number): Promise<Chapter | null> {
  const r = await selectOne<RawC>('SELECT * FROM chapters WHERE novel_id = ? AND chapter_no = ?', [novelId, chapterNo]);
  return r ? mapC(r) : null;
}
export async function upsertChapterPlan(novelId: string, plan: { chapterNo: number; title?: string; goal?: string; targetChars?: number; povCharacterId?: string | null; beatIds?: string[]; endHook?: string }, commit: AtomicWriter = writeAtomic): Promise<Chapter> {
  const existing = await getChapterByNo(novelId, plan.chapterNo);
  if (existing) {
    await writeStatement(commit, 'UPDATE chapters SET title=?, goal=?, target_chars=?, pov_character_id=?, beat_ids=?, end_hook=?, updated_at=? WHERE id=?', [
      plan.title ?? existing.title, plan.goal ?? existing.goal, plan.targetChars ?? existing.targetChars, plan.povCharacterId === undefined ? existing.povCharacterId : plan.povCharacterId,
      JSON.stringify(plan.beatIds ?? existing.beatIds), plan.endHook ?? existing.endHook, now(), existing.id,
    ]);
    return (await getChapter(existing.id))!;
  }
  const id = nanoid();
  await writeStatement(commit,
    'INSERT INTO chapters(id, novel_id, chapter_no, title, goal, target_chars, pov_character_id, beat_ids, end_hook, status, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [id, novelId, plan.chapterNo, plan.title ?? '', plan.goal ?? '', plan.targetChars ?? 0, plan.povCharacterId ?? null, JSON.stringify(plan.beatIds ?? []), plan.endHook ?? '', 'planned', now()],
  );
  return (await getChapter(id))!;
}
export async function deleteChaptersFrom(novelId: string, fromChapterNo: number): Promise<void> {
  await getDb().execute('DELETE FROM chapters WHERE novel_id = ? AND chapter_no >= ?', [novelId, fromChapterNo]);
}
export async function setChapterStatus(id: string, status: ChapterStatus, staleReasons?: string[], commit: AtomicWriter = writeAtomic): Promise<void> {
  if (staleReasons) await writeStatement(commit, 'UPDATE chapters SET status = ?, stale_reasons = ?, updated_at = ? WHERE id = ?', [status, JSON.stringify(staleReasons), now(), id]);
  else await writeStatement(commit, 'UPDATE chapters SET status = ?, updated_at = ? WHERE id = ?', [status, now(), id]);
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
export async function getVersion(id: string | null): Promise<ChapterVersion | null> {
  if (id === null) return null;
  const r = await selectOne<RawV>('SELECT * FROM chapter_versions WHERE id = ?', [id]);
  if (!r) return null;
  const version=mapV(r);
  // V8 prose stays immutable; derive its missing hash without rewriting history.
  if (!version.contentHash) version.contentHash=await sha256Hex(version.content);
  return version;
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
/** New prose is a working candidate. Only imported existing prose bypasses review, labelled legacy. */
export async function createVersion(input: { chapterId: string; content: string; source: VersionSource; summary?: string; storylineSnapshotId?: string | null; jobStepId?: string | null; model?: string | null; usage?: ChapterVersion['usage']; status?: ChapterStatus; sessionId?: string | null; expectedWorkingVersionId?: string | null; expectedWorkingHash?: string | null; acceptProposalId?: string; atomicTail?: AtomicOperation[]; cancelStructure?: boolean; commit?: AtomicWriter }): Promise<ChapterVersion> {
  const chapter = await getChapter(input.chapterId);
  if (!chapter) throw new Error('章节不存在');
  const expected = input.expectedWorkingVersionId === undefined ? chapter.currentVersionId : input.expectedWorkingVersionId;
  const expectedVersion = expected ? await getVersion(expected) : null;
  if (input.expectedWorkingHash != null && expectedVersion?.contentHash !== input.expectedWorkingHash) throw new Error('Concurrent modification: 工作稿内容已变化，请重新生成或合并候选');
  const storyGuards: AtomicOperation[] = [];
  if (input.acceptProposalId || ['generated','rewritten','topup','trim'].includes(input.source)) {
    const { assertStoryTextEdit } = await import('./storyGraphRepo');
    const previous = expectedVersion?.content ?? '';
    let from = 0, tail = 0;
    while (from < Math.min(previous.length,input.content.length) && previous[from] === input.content[from]) from++;
    while (tail < previous.length-from && tail < input.content.length-from && previous.at(-1-tail) === input.content.at(-1-tail)) tail++;
    const row = await selectOne<{json:string}>('SELECT json FROM story_graphs WHERE novel_id=?',[chapter.novelId]);
    await assertStoryTextEdit(chapter.novelId, chapter.id, previous, from, previous.length-tail);
    storyGuards.push({sql:"UPDATE novels SET id=id WHERE id=? AND COALESCE((SELECT json FROM story_graphs WHERE novel_id=?),'')=?",params:[chapter.novelId,chapter.novelId,row?.json ?? ''],expectedRows:1});
    if (input.acceptProposalId) {
      const proposal = await selectOne<{json:string}>("SELECT json FROM writing_proposals WHERE id=? AND chapter_id=? AND kind='text' AND state IN ('pending','conflict')",[input.acceptProposalId,chapter.id]);
      if (!proposal) throw new Error('候选已处理或不存在');
      const { acceptTextProposal } = await import('@/novel/assistant');
      if (await acceptTextProposal(TextProposalSchema.parse(JSON.parse(proposal.json)),previous) !== input.content) throw new Error('采纳正文与已审阅候选不一致');
    }
  }
  const id = nanoid(), t = now(), hash = await sha256Hex(input.content);
  const imported = input.source === 'imported' && !chapter.committedVersionId;
  await (input.commit ?? writeAtomic)([
    ...storyGuards,
    ...(input.acceptProposalId ? [{sql:"UPDATE writing_proposals SET state='accepted' WHERE id=? AND chapter_id=? AND kind='text' AND state IN ('pending','conflict')",params:[input.acceptProposalId,chapter.id],expectedRows:1}]:[]),
    { sql: 'UPDATE chapters SET updated_at = updated_at WHERE id = ? AND current_version_id IS ?', params: [chapter.id, expected], expectedRows: 1 },
    ...(expectedVersion ? [{sql:'UPDATE chapter_versions SET id=id WHERE id=? AND content=?',params:[expectedVersion.id,expectedVersion.content],expectedRows:1}] : []),
    { sql: `INSERT INTO chapter_versions(id, chapter_id, version_no, content, char_count, summary, source, storyline_snapshot_id, job_step_id, model, usage, created_at, state, baseline_version_id, pinned, session_id, updated_at, content_hash, committed_at)
      VALUES (?,?,(SELECT COALESCE(MAX(version_no),0)+1 FROM chapter_versions WHERE chapter_id=?),?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)`,
      params: [id, chapter.id, chapter.id, input.content, countZh(input.content), input.summary ?? '', input.source, input.storylineSnapshotId ?? null, input.jobStepId ?? null, input.model ?? null, input.usage ? JSON.stringify(input.usage) : null, t, imported ? 'accepted' : 'pending', chapter.committedVersionId, imported ? null : input.sessionId ?? null, t, hash, imported ? t : null] },
    { sql: 'UPDATE chapters SET current_version_id=?, status=?, updated_at=? WHERE id=?', params: [id, input.status ?? 'draft', t, chapter.id] },
    {sql:input.cancelStructure ? "UPDATE chapter_structure_changes SET state='cancelled' WHERE chapter_id=? AND state='pending'" : "UPDATE chapter_structure_changes SET candidate_version_id=? WHERE chapter_id=? AND state='pending' AND candidate_version_id IS ?",params:input.cancelStructure ? [chapter.id]:[id,chapter.id,expected]},
    ...(input.atomicTail ?? []),
    ...(imported ? [
      { sql: "UPDATE chapters SET committed_version_id=?, memory_status='legacy' WHERE id=?", params: [id, chapter.id] },
      { sql: "INSERT INTO chapter_commits(id,chapter_id,version_id,content_hash,review_id,dependency_hash,kind,created_at) VALUES (?,?,?,?,NULL,'','legacy',?)", params: [nanoid(), chapter.id, id, hash, t] },
    ] : []),
  ]);
  return (await getVersion(id))!;
}
export async function updateVersionSummary(id: string, summary: string): Promise<void> {
  await getDb().execute('UPDATE chapter_versions SET summary = ? WHERE id = ?', [summary, id]);
}
export async function restoreVersion(chapterId: string, versionId: string): Promise<void> {
  const version = await getVersion(versionId);
  if (!version || version.chapterId !== chapterId) throw new Error('版本不属于此章节');
  // Restoring creates a candidate, never edits history or publishes unreviewed facts.
  await createVersion({ chapterId, content: version.content, source: 'user_edit' });
}

export async function getCommittedVersion(chapterId: string): Promise<ChapterVersion | null> {
  const chapter = await getChapter(chapterId);
  return chapter?.committedVersionId ? getVersion(chapter.committedVersionId) : null;
}

// ---------------------------------------------------------------------------
// 会话级自动保存（§2.2 第 3 条）
// ---------------------------------------------------------------------------

/**
 * 手动编辑的自动保存：同一次编辑会话只占一个版本行，反复覆盖它。
 * 原来每 2 秒空闲就 createVersion 一次，改几分钟能攒出几十稿。
 */
export async function saveSessionEdit(input: { chapterId: string; sessionId: string; content: string; summary?: string; status?: ChapterStatus; expectedHash?: string; expectedWorkingVersionId?: string | null }): Promise<ChapterVersion> {
  const open = await selectOne<RawV>('SELECT * FROM chapter_versions WHERE chapter_id=? AND session_id=? AND committed_at IS NULL ORDER BY version_no DESC LIMIT 1', [input.chapterId, input.sessionId]);
  if (!open) return createVersion({ ...input, expectedWorkingHash:input.expectedHash, source: 'user_edit' });
  const hash = await sha256Hex(input.content), t = now();
  await getDb().atomic([
    { sql: 'UPDATE chapters SET current_version_id=current_version_id WHERE id=? AND current_version_id=?', params: [input.chapterId, open.id], expectedRows: 1 },
    { sql: 'UPDATE chapter_versions SET content=?, char_count=?, content_hash=?, updated_at=? WHERE id=? AND content_hash=? AND session_id=? AND committed_at IS NULL', params: [input.content, countZh(input.content), hash, t, open.id, input.expectedHash ?? open.content_hash, input.sessionId], expectedRows: 1 },
    { sql: 'UPDATE chapter_reviews SET valid=0 WHERE chapter_version_id=? AND content_hash<>?', params: [open.id, hash] },
    { sql: 'UPDATE chapters SET updated_at=? WHERE id=?', params: [t, input.chapterId] },
  ]);
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
export async function beginRewriteSession(chapterIds: readonly string[], jobId: string | null = null, commit: AtomicWriter = writeAtomic): Promise<number> {
  let opened = 0;
  for (const chapterId of chapterIds) {
    const c = await getChapter(chapterId);
    if (!c?.currentVersionId || c.rewriteBaselineVersionId) continue;
    await writeStatement(commit, 'UPDATE chapters SET rewrite_baseline_version_id = ?, rewrite_baseline_status = ?, rewrite_job_id = ?, updated_at = ? WHERE id = ?', [c.currentVersionId, c.status, jobId, now(), chapterId]);
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
export async function resolveRewrite(chapterId: string, action: RewriteAction, commit: AtomicWriter = writeAtomic): Promise<void> {
  const c = await getChapter(chapterId);
  if (!c?.rewriteBaselineVersionId) return;
  if (action === 'accept') {
    const { commitPreparedChapter } = await import('./writingRepo');
    if (!c.currentVersionId) throw new Error('没有候选正文');
    await commitPreparedChapter(chapterId, c.currentVersionId, true, commit);
    const {listJobs,listSteps}=await import('./jobsRepo');
    const {emitJobEvent}=await import('@/jobs/events');
    for(const job of await listJobs({novelId:c.novelId})) {
      emitJobEvent({type:'job:updated',job});
      for(const step of await listSteps(job.id)) emitJobEvent({type:'step:updated',step});
    }
    emitJobEvent({type:'novel:bibleUpdated',novelId:c.novelId,afterChapterNo:c.chapterNo});
    return;
  }
  await commit([
    { sql: 'UPDATE chapters SET current_version_id=?, status=?, rewrite_baseline_version_id=NULL, rewrite_baseline_status=NULL, rewrite_job_id=NULL, updated_at=? WHERE id=? AND current_version_id IS ?', params: [c.rewriteBaselineVersionId, c.rewriteBaselineStatus ?? 'draft', now(), c.id, c.currentVersionId], expectedRows: 1 },
    { sql: "UPDATE chapter_versions SET state='discarded', session_id=NULL WHERE chapter_id=? AND state='pending' AND id<>?", params: [c.id, c.rewriteBaselineVersionId] },
  ]);
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
  if ((await protectedProposalVersions(v.chapterId)).has(v.id)) throw new Error('此版本仍是未处理修订建议的依据');
  const reason = versionLock(prunable(v), { currentVersionId: c?.currentVersionId ?? null, baselineVersionId: c?.rewriteBaselineVersionId ?? null });
  if (reason) throw new Error(reason);
  await getDb().execute('DELETE FROM chapter_versions WHERE id = ?', [id]);
}

/** 按「保留最近 N 稿」清理一章；返回删掉的稿数。 */
async function protectedProposalVersions(chapterId: string): Promise<Set<string>> {
  const rows = await getDb().select<{ id: string }>("SELECT json_extract(json,'$.baseVersionId') AS id FROM writing_proposals WHERE chapter_id=? AND kind='text' AND state IN ('pending','conflict')", [chapterId]);
  const anchors = await getDb().select<{id:string}>("SELECT json_extract(a.value,'$.versionId') AS id FROM story_graphs g,json_each(g.json,'$.anchors') a WHERE json_extract(a.value,'$.chapterId')=? UNION SELECT json_extract(a.value,'$.versionId') FROM story_graphs g,json_each(g.json,'$.lockedAnchors') a WHERE json_extract(a.value,'$.chapterId')=?",[chapterId,chapterId]);
  const readings = await getDb().select<{id:string}>("SELECT json_extract(json,'$.versionId') AS id FROM story_suggestions WHERE state='pending' AND json_extract(json,'$.chapterId')=?",[chapterId]);
  const history = await getDb().select<{id:string}>("SELECT json_extract(a.value,'$.versionId') AS id FROM story_changes h,json_each(h.before_json,'$.anchors') a WHERE h.undone=0 AND json_extract(a.value,'$.chapterId')=? UNION SELECT json_extract(a.value,'$.versionId') FROM story_changes h,json_each(h.before_json,'$.lockedAnchors') a WHERE h.undone=0 AND json_extract(a.value,'$.chapterId')=?",[chapterId,chapterId]);
  const assistant = await getDb().select<{id:string}>("SELECT json_extract(c.before_json,'$.current_version_id') AS id FROM assistant_row_changes c JOIN assistant_operations o ON o.id=c.operation_id WHERE c.table_name='chapters' AND c.row_id=? AND o.state<>'undone' UNION SELECT json_extract(c.after_json,'$.current_version_id') FROM assistant_row_changes c JOIN assistant_operations o ON o.id=c.operation_id WHERE c.table_name='chapters' AND c.row_id=?",[chapterId,chapterId]);
  return new Set([...rows,...anchors,...readings,...history,...assistant].map(r => r.id));
}

export async function pruneVersions(chapterId: string, keep: number = DEFAULT_KEEP_VERSIONS): Promise<number> {
  const c = await getChapter(chapterId);
  if (!c) return 0;
  const versions = await listVersions(chapterId);
  const protectedIds = await protectedProposalVersions(chapterId);
  const ids = selectVersionsToPrune({ versions: versions.map(v => ({...prunable(v), pinned: prunable(v).pinned || protectedIds.has(v.id)})), keep, currentVersionId: c.currentVersionId, baselineVersionId: c.rewriteBaselineVersionId });
  for (const id of ids) await getDb().execute('DELETE FROM chapter_versions WHERE id = ?', [id]);
  return ids.length;
}

/** 界面上先问一句「会删掉几稿」用的预演。 */
export async function previewPrune(chapterId: string, keep: number = DEFAULT_KEEP_VERSIONS): Promise<number> {
  const c = await getChapter(chapterId);
  if (!c) return 0;
  const versions = await listVersions(chapterId);
  const protectedIds = await protectedProposalVersions(chapterId);
  return selectVersionsToPrune({ versions: versions.map(v => ({...prunable(v), pinned: prunable(v).pinned || protectedIds.has(v.id)})), keep, currentVersionId: c.currentVersionId, baselineVersionId: c.rewriteBaselineVersionId }).length;
}
/** Current versions of all chapters of a novel in order (content included). */
export async function listCurrentVersions(novelId: string, opts: { draft?: boolean } = {}): Promise<Array<{ chapter: Chapter; version: ChapterVersion | null }>> {
  const chapters = await listChapters(novelId);
  const out: Array<{ chapter: Chapter; version: ChapterVersion | null }> = [];
  for (const c of chapters) { const id = opts.draft ? c.currentVersionId : c.committedVersionId; out.push({ chapter: c, version: id ? await getVersion(id) : null }); }
  return out;
}
/** 一次聚合拿到所有小说的字数（书架页避免每本一次查询）。缺席的小说按 0 计。 */
export async function novelCharCounts(): Promise<Record<string, number>> {
  const rows = await getDb().select<{ novel_id: string; s: number | null }>(
    'SELECT c.novel_id AS novel_id, SUM(v.char_count) AS s FROM chapters c JOIN chapter_versions v ON v.id = c.current_version_id WHERE c.archived_at IS NULL GROUP BY c.novel_id',
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.novel_id] = num(r.s);
  return out;
}
export async function novelCharCount(novelId: string): Promise<number> {
  const r = await selectOne<{ s: number | null }>(
    'SELECT SUM(v.char_count) AS s FROM chapters c JOIN chapter_versions v ON v.id = c.current_version_id WHERE c.novel_id = ? AND c.archived_at IS NULL', [novelId],
  );
  return r?.s ?? 0;
}

export async function listArchivedChapters(novelId:string):Promise<Chapter[]> {
 return (await getDb().select<RawC>('SELECT * FROM chapters WHERE novel_id=? AND archived_at IS NOT NULL ORDER BY archived_at DESC',[novelId])).map(mapC);
}
