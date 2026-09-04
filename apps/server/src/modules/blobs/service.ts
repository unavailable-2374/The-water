import { eq, inArray, sql } from 'drizzle-orm';
import {
  LIMITS,
  countZh,
  hashChapterContent,
  normalizeChapterText,
  utf8ByteLength,
  type MyStorageResponse,
  type UploadBlobsRequest,
  type UploadBlobsResponse,
} from '@the-water/shared';
import type { AppDeps, AuthUser } from '../../context';
import { blobs } from '../../db/schema';
import { ApiError } from '../../lib/errors';

const IN_CHUNK = 400;

/** 返回给定 hash 中尚未入库的部分（保持输入顺序，去重）。 */
export function findMissingHashes(deps: AppDeps, hashes: string[]): string[] {
  const unique = Array.from(new Set(hashes));
  const present = new Set<string>();
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK);
    const rows = deps.db.select({ hash: blobs.hash }).from(blobs).where(inArray(blobs.hash, chunk)).all();
    for (const r of rows) present.add(r.hash);
  }
  return unique.filter((h) => !present.has(h));
}

/**
 * 当前用户的存储占用：按 `blobs.first_uploader_id` 统计。
 * 内容寻址去重下，同一段内容只算给第一个上传者。
 */
export function storageUsage(deps: AppDeps, userId: string): MyStorageResponse {
  const row = deps.db
    .select({
      used: sql<number>`coalesce(sum(${blobs.byteSize}), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(blobs)
    .where(eq(blobs.firstUploaderId, userId))
    .get();
  return {
    usedBytes: Number(row?.used ?? 0),
    quotaBytes: deps.env.storageQuotaBytes,
    blobCount: Number(row?.count ?? 0),
  };
}

/**
 * 配额校验：只计入本次真正会新增的 blob（已入库的 hash 不占新空间）。
 * `storageQuotaBytes === 0` 表示不限制。超额时整批拒绝，避免半批写入让客户端难以对账。
 */
function assertQuota(deps: AppDeps, user: AuthUser, rows: Array<typeof blobs.$inferInsert>): void {
  if (deps.env.storageQuotaBytes <= 0 || !rows.length) return;
  const missing = new Set(findMissingHashes(deps, rows.map((r) => r.hash)));
  const seen = new Set<string>();
  let incoming = 0;
  for (const r of rows) {
    if (!missing.has(r.hash) || seen.has(r.hash)) continue;
    seen.add(r.hash);
    incoming += r.byteSize;
  }
  if (incoming <= 0) return;
  const { usedBytes, quotaBytes } = storageUsage(deps, user.id);
  if (usedBytes + incoming > quotaBytes) {
    throw new ApiError(
      'STORAGE_QUOTA_EXCEEDED',
      `存储配额不足：已用 ${usedBytes} 字节 / 上限 ${quotaBytes} 字节，本次还需 ${incoming} 字节`,
      { usedBytes, quotaBytes, incomingBytes: incoming },
    );
  }
}

/** 服务端重算 hash，不匹配拒绝；已存在的 blob 视为 accepted（内容寻址去重）。 */
export async function uploadBlobs(deps: AppDeps, user: AuthUser, req: UploadBlobsRequest): Promise<UploadBlobsResponse> {
  const accepted: string[] = [];
  const rejected: UploadBlobsResponse['rejected'] = [];
  const toInsert: Array<typeof blobs.$inferInsert> = [];
  const now = deps.clock.now();

  for (const b of req.blobs) {
    const content = normalizeChapterText(b.content);
    const charCount = countZh(content);
    if (charCount > LIMITS.MAX_CHARS_PER_CHAPTER) {
      rejected.push({ hash: b.hash, code: 'TOO_LARGE' });
      continue;
    }
    const actual = await hashChapterContent(content);
    if (actual !== b.hash) {
      rejected.push({ hash: b.hash, code: 'HASH_MISMATCH' });
      continue;
    }
    accepted.push(b.hash);
    toInsert.push({ hash: b.hash, content, charCount, byteSize: utf8ByteLength(content), firstUploaderId: user.id, createdAt: now });
  }

  assertQuota(deps, user, toInsert);

  if (toInsert.length) {
    deps.db.transaction((tx) => {
      for (const row of toInsert) tx.insert(blobs).values(row).onConflictDoNothing().run();
    });
  }
  return { accepted, rejected };
}

export function loadBlobs(deps: AppDeps, hashes: string[]): Map<string, { content: string; charCount: number }> {
  const out = new Map<string, { content: string; charCount: number }>();
  const unique = Array.from(new Set(hashes));
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK);
    const rows = deps.db
      .select({ hash: blobs.hash, content: blobs.content, charCount: blobs.charCount })
      .from(blobs)
      .where(inArray(blobs.hash, chunk))
      .all();
    for (const r of rows) out.set(r.hash, { content: r.content, charCount: r.charCount });
  }
  return out;
}
