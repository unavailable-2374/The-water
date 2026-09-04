import { inArray } from 'drizzle-orm';
import {
  LIMITS,
  countZh,
  hashChapterContent,
  normalizeChapterText,
  utf8ByteLength,
  type UploadBlobsRequest,
  type UploadBlobsResponse,
} from '@the-water/shared';
import type { AppDeps, AuthUser } from '../../context';
import { blobs } from '../../db/schema';

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
