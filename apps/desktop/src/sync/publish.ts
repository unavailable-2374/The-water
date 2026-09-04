/**
 * Publish protocol (plan §4.4): ensure remote novel → POST version manifest (Idempotency-Key)
 * → upload missing blobs in batches → commit (retry on BLOBS_MISSING). `remote` state is
 * persisted on the local novel after every stage so `resumePublish` can continue after a crash.
 */
import { nanoid } from 'nanoid';
import {
  LIMITS,
  countZh,
  hashChapterContent,
  hashStoryline,
  normalizeChapterText,
  utf8ByteLength,
  type ChapterManifestEntry,
  type License,
  type StoryBible,
  type StorylineDoc,
  type VersionSummary,
} from '@the-water/shared';
import { getNovel, updateNovel, type Novel, type RemoteState } from '@/db/repos/novelsRepo';
import { listCurrentVersions } from '@/db/repos/chaptersRepo';
import { buildStorylineDoc } from '@/db/repos/storylineRepo';
import { latestBible } from '@/db/repos/bibleRepo';
import { ApiError, type PublicApi } from './api';
import { getClient } from './account';

export interface PublishOptions {
  title: string;
  summary: string;
  tags: string[];
  license: License;
  allowDerivatives: boolean;
  writingStatus: 'ongoing' | 'completed';
  visibility: 'public' | 'unlisted';
  changeNote?: string;
}

export type ProgressFn = (message: string, done: number, total: number) => void;

/** `RemoteState` plus the last committed version number (kept for the「已发布 vN」badge). */
export interface RemoteStateWithVersion extends RemoteState {
  versionNumber?: number;
}
export function remoteVersionNumber(novel: Novel): number | null {
  const r = novel.remote as RemoteStateWithVersion | null;
  return r?.currentVersionId ? (r.versionNumber ?? null) : null;
}

export interface LocalManifest {
  entries: ChapterManifestEntry[];
  /** hash → normalized content */
  contents: Map<string, string>;
  storyline: StorylineDoc;
  storylineHash: string;
  bible: StoryBible | null;
}

/** Hash every chapter with a current version; empty chapters are skipped (server needs ≥1). */
export async function computeLocalManifest(novel: Novel): Promise<LocalManifest> {
  const rows = await listCurrentVersions(novel.id);
  const entries: ChapterManifestEntry[] = [];
  const contents = new Map<string, string>();
  for (const { chapter, version } of rows) {
    if (!version) continue;
    const normalized = normalizeChapterText(version.content);
    if (!normalized) continue;
    const charCount = countZh(normalized);
    if (charCount > LIMITS.MAX_CHARS_PER_CHAPTER) throw new Error(`第 ${chapter.chapterNo} 章超过 ${LIMITS.MAX_CHARS_PER_CHAPTER} 字，无法发布`);
    const hash = await hashChapterContent(normalized);
    entries.push({ index: entries.length, title: (chapter.title || `第${chapter.chapterNo}章`).slice(0, LIMITS.NOVEL_TITLE_MAX), hash, charCount });
    contents.set(hash, normalized);
  }
  if (entries.length > LIMITS.MAX_CHAPTERS_PER_VERSION) throw new Error(`章节数超过 ${LIMITS.MAX_CHAPTERS_PER_VERSION}，无法发布`);
  const storyline = await buildStorylineDoc(novel.id, novel.premise, novel.meta.themes);
  const storylineHash = await hashStoryline(storyline);
  const bible = (await latestBible(novel.id))?.bible ?? null;
  return { entries, contents, storyline, storylineHash, bible };
}

export interface PublishDiff {
  total: number;
  changed: number;
  storylineChanged: boolean;
}

/** Compare local chapter hashes with the last committed remote state. */
export async function diffAgainstRemote(novel: Novel): Promise<PublishDiff> {
  const m = await computeLocalManifest(novel);
  const remoteHashes = new Set(novel.remote?.chapterHashes ?? []);
  const changed = m.entries.filter((e) => !remoteHashes.has(e.hash)).length;
  return { total: m.entries.length, changed, storylineChanged: novel.remote?.storylineHash !== m.storylineHash };
}

// ---------------------------------------------------------------------------

async function requireClient(): Promise<PublicApi> {
  const client = await getClient();
  if (!client) throw new Error('尚未登录云端账号');
  return client;
}

async function saveRemote(novelId: string, remote: RemoteStateWithVersion): Promise<void> {
  await updateNovel(novelId, { remote });
}

function emptyRemote(serverUrl: string, novelId: string): RemoteStateWithVersion {
  return { serverUrl, novelId, currentVersionId: null, chapterHashes: [], storylineHash: null, draftVersionId: null, publishAttemptId: null, publishedAt: null };
}

/** Create the remote novel (or PATCH metadata when it already exists). Returns the up-to-date remote state. */
async function ensureRemoteNovel(client: PublicApi, novel: Novel, opts: PublishOptions): Promise<RemoteStateWithVersion> {
  const existing = novel.remote as RemoteStateWithVersion | null;
  const allowDerivatives = opts.license === 'all-rights-reserved' ? false : opts.allowDerivatives;
  const meta = {
    title: opts.title.trim(),
    summary: opts.summary,
    tags: opts.tags,
    writingStatus: opts.writingStatus,
    license: opts.license,
    allowDerivatives,
    visibility: opts.visibility,
  };
  if (existing && existing.serverUrl === client.baseUrl && existing.novelId) {
    try {
      await client.updateNovel(existing.novelId, meta);
      return existing;
    } catch (e) {
      // Deleted on the server (or never really created): fall through and create again.
      if (!(e instanceof ApiError && e.code === 'NOT_FOUND')) throw e;
    }
  }
  const source = novel.origin && novel.origin.serverUrl === client.baseUrl ? { forkId: novel.origin.forkId } : undefined;
  const { novel: created } = await client.createNovel({ ...meta, language: 'zh-CN', source });
  const remote = emptyRemote(client.baseUrl, created.id);
  await saveRemote(novel.id, remote);
  return remote;
}

function batchBlobs(hashes: string[], contents: Map<string, string>): Array<Array<{ hash: string; content: string }>> {
  const batches: Array<Array<{ hash: string; content: string }>> = [];
  let cur: Array<{ hash: string; content: string }> = [];
  let curBytes = 0;
  for (const hash of hashes) {
    const content = contents.get(hash);
    if (content === undefined) throw new Error(`本地缺少章节内容（${hash.slice(0, 8)}…），请重新发布`);
    const bytes = utf8ByteLength(content) + 120;
    if (cur.length > 0 && (cur.length >= LIMITS.BLOB_BATCH_MAX_COUNT || curBytes + bytes > LIMITS.BLOB_BATCH_MAX_BYTES)) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push({ hash, content });
    curBytes += bytes;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!(e instanceof ApiError) || !e.retryable || i === attempts - 1) throw e;
      await sleep(500 * 2 ** i);
    }
  }
  throw last;
}

/** Upload the given hashes in ≤20-blob / ≤3MB batches, 3 in flight, with backoff on network/5xx. */
async function uploadMissing(client: PublicApi, hashes: string[], contents: Map<string, string>, onProgress: (uploaded: number) => void): Promise<void> {
  const batches = batchBlobs(hashes, contents);
  let uploaded = 0;
  let next = 0;
  const rejected: string[] = [];
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++]!;
      const res = await withRetry(() => client.uploadBlobs(batch));
      for (const r of res.rejected) rejected.push(`${r.hash.slice(0, 8)}…(${r.code})`);
      uploaded += batch.length;
      onProgress(uploaded);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, batches.length) }, worker));
  if (rejected.length) throw new Error(`服务器拒绝了 ${rejected.length} 个章节内容：${rejected.slice(0, 3).join('，')}`);
}

/** Commit, uploading whatever the server still reports missing (max 3 rounds). */
async function commitWithRetry(client: PublicApi, remoteNovelId: string, versionId: string, contents: Map<string, string>, onProgress: (msg: string) => void) {
  for (let round = 0; ; round++) {
    try {
      return await withRetry(() => client.commitVersion(remoteNovelId, versionId));
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'BLOBS_MISSING') || round >= 3) throw e;
      const missing = (e.details?.missingHashes as string[] | undefined) ?? [];
      if (!missing.length) throw e;
      onProgress(`补传 ${missing.length} 个章节…`);
      await uploadMissing(client, missing, contents, () => undefined);
    }
  }
}

async function finalizeRemote(novelId: string, remote: RemoteStateWithVersion, version: VersionSummary, chapterHashes: string[]): Promise<void> {
  await saveRemote(novelId, {
    ...remote,
    currentVersionId: version.id,
    versionNumber: version.versionNumber,
    chapterHashes,
    storylineHash: version.storylineHash,
    draftVersionId: null,
    publishAttemptId: null,
    publishedAt: version.committedAt ?? new Date().toISOString(),
  });
}

/**
 * Publish (or update) a local novel to the public area. Resolves with the committed version.
 */
export async function publishNovel(novelId: string, opts: PublishOptions, onProgress: ProgressFn = () => undefined): Promise<VersionSummary> {
  const client = await requireClient();
  const novel = await getNovel(novelId);
  if (!novel) throw new Error('小说不存在');

  onProgress('正在整理章节…', 0, 1);
  const manifest = await computeLocalManifest(novel);
  if (manifest.entries.length === 0) throw new Error('还没有可发布的章节正文');

  onProgress('同步小说信息…', 0, 1);
  let remote = await ensureRemoteNovel(client, novel, opts);

  // Reuse the pending attempt so a replayed POST returns the same draft; otherwise start fresh.
  let attemptId = remote.draftVersionId && remote.publishAttemptId ? remote.publishAttemptId : nanoid();
  remote = { ...remote, publishAttemptId: attemptId };
  await saveRemote(novelId, remote);

  onProgress('提交章节清单…', 0, 1);
  const body = { storyline: manifest.storyline, bible: manifest.bible, chapters: manifest.entries, changeNote: opts.changeNote?.trim() || undefined };
  let created = await withRetry(() => client.createVersion(remote.novelId, body, attemptId));
  const stale =
    created.version.status === 'aborted' ||
    (created.version.status === 'draft' &&
      (created.version.chapterCount !== manifest.entries.length || created.version.storylineHash !== manifest.storylineHash));
  if (stale) {
    // The replayed draft no longer matches local content: abort it and open a new attempt.
    if (created.version.status === 'draft') await client.abortVersion(remote.novelId, created.version.id).catch(() => undefined);
    attemptId = nanoid();
    remote = { ...remote, publishAttemptId: attemptId, draftVersionId: null };
    await saveRemote(novelId, remote);
    created = await withRetry(() => client.createVersion(remote.novelId, body, attemptId));
  }
  if (created.version.status === 'committed') {
    await finalizeRemote(novelId, remote, created.version, manifest.entries.map((e) => e.hash));
    onProgress('已发布', 1, 1);
    return created.version;
  }
  remote = { ...remote, draftVersionId: created.version.id };
  await saveRemote(novelId, remote);

  const missing = created.missingHashes;
  const total = missing.length + 1;
  onProgress(missing.length ? `上传章节 0/${missing.length}` : '章节内容已在云端', 0, total);
  await uploadMissing(client, missing, manifest.contents, (n) => onProgress(`上传章节 ${n}/${missing.length}`, n, total));

  onProgress('提交版本…', missing.length, total);
  const committed = await commitWithRetry(client, remote.novelId, created.version.id, manifest.contents, (m) => onProgress(m, missing.length, total));
  await finalizeRemote(novelId, remote, committed.version, manifest.entries.map((e) => e.hash));
  onProgress('已发布', total, total);
  return committed.version;
}

/**
 * Continue a publish interrupted after the draft was created: fetch the draft's missing
 * hashes, upload them from local content, commit. Throws when local content no longer
 * matches the draft (the draft is aborted so a fresh `publishNovel` can run).
 */
export async function resumePublish(novelId: string, onProgress: ProgressFn = () => undefined): Promise<VersionSummary> {
  const client = await requireClient();
  const novel = await getNovel(novelId);
  if (!novel) throw new Error('小说不存在');
  const remote = novel.remote as RemoteStateWithVersion | null;
  if (!remote?.draftVersionId || remote.serverUrl !== client.baseUrl) throw new Error('没有待续传的发布');

  onProgress('查询草稿状态…', 0, 1);
  const status = await client.getVersion(remote.novelId, remote.draftVersionId);
  const hashesOf = async () => (await client.listChapters(remote.novelId, status.version.id, { limit: 200 })).items.map((c) => c.hash);
  if (status.version.status === 'committed') {
    await finalizeRemote(novelId, remote, status.version, await hashesOf());
    onProgress('已发布', 1, 1);
    return status.version;
  }
  if (status.version.status !== 'draft') {
    await saveRemote(novelId, { ...remote, draftVersionId: null, publishAttemptId: null });
    throw new Error('草稿已中止，请重新发布');
  }

  onProgress('正在整理章节…', 0, 1);
  const manifest = await computeLocalManifest(novel);
  const missing = status.missingHashes ?? [];
  if (missing.some((h) => !manifest.contents.has(h))) {
    await client.abortVersion(remote.novelId, status.version.id).catch(() => undefined);
    await saveRemote(novelId, { ...remote, draftVersionId: null, publishAttemptId: null });
    throw new Error('本地章节已变化，草稿已作废，请重新发布');
  }
  const total = missing.length + 1;
  await uploadMissing(client, missing, manifest.contents, (n) => onProgress(`上传章节 ${n}/${missing.length}`, n, total));
  onProgress('提交版本…', missing.length, total);
  const committed = await commitWithRetry(client, remote.novelId, status.version.id, manifest.contents, (m) => onProgress(m, missing.length, total));
  await finalizeRemote(novelId, remote, committed.version, await hashesOf().catch(() => manifest.entries.map((e) => e.hash)));
  onProgress('已发布', total, total);
  return committed.version;
}
