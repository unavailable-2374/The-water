import { z } from 'zod';
import { LIMITS } from '../constants';

export const UploadBlobsRequestSchema = z.object({
  blobs: z
    .array(z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/), content: z.string().max(LIMITS.MAX_CHARS_PER_CHAPTER * 4) }))
    .min(1)
    .max(LIMITS.BLOB_BATCH_MAX_COUNT),
});
export type UploadBlobsRequest = z.infer<typeof UploadBlobsRequestSchema>;

export const UploadBlobsResponseSchema = z.object({
  accepted: z.array(z.string()),
  rejected: z.array(z.object({ hash: z.string(), code: z.enum(['HASH_MISMATCH', 'TOO_LARGE']) })),
});
export type UploadBlobsResponse = z.infer<typeof UploadBlobsResponseSchema>;

/** `GET /me/storage`：当前用户的 blob 存储占用；quotaBytes 为 0 表示不限制。 */
export const MyStorageResponseSchema = z.object({
  usedBytes: z.number().int().min(0),
  quotaBytes: z.number().int().min(0),
  blobCount: z.number().int().min(0),
});
export type MyStorageResponse = z.infer<typeof MyStorageResponseSchema>;
