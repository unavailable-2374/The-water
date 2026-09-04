import { z } from 'zod';
import { NovelRefSchema } from '../novel';
import { pageSchema } from './common';

export const CreateForkRequestSchema = z.object({ versionId: z.string().optional() });

export const ForkSchema = z.object({
  id: z.string(),
  sourceNovelId: z.string(),
  sourceVersionId: z.string(),
  sourceVersionNumber: z.number().int(),
  derivativeNovelId: z.string().nullable(),
  createdAt: z.string(),
});
export type Fork = z.infer<typeof ForkSchema>;

export const ForkWithRefsSchema = ForkSchema.extend({
  source: NovelRefSchema,
  derivative: NovelRefSchema.nullable(),
});

export interface LineageNode {
  novel: z.infer<typeof NovelRefSchema>;
  sourceVersionNumber: number | null;
  children: LineageNode[];
}
export const LineageNodeSchema: z.ZodType<LineageNode> = z.lazy(() =>
  z.object({
    novel: NovelRefSchema,
    sourceVersionNumber: z.number().int().nullable(),
    children: z.array(LineageNodeSchema),
  }),
);

export const LineageResponseSchema = z.object({
  root: NovelRefSchema,
  ancestors: z.array(NovelRefSchema),
  self: NovelRefSchema,
  descendants: z.array(LineageNodeSchema),
  /** 后代节点数超过服务端上限、树被截断时为 true（缺失的是最新的一批派生）。 */
  descendantsTruncated: z.boolean().optional(),
});
export type LineageResponse = z.infer<typeof LineageResponseSchema>;

/** `POST /novels/:id/forks` 的响应体。 */
export const ForkResponseSchema = z.object({ fork: ForkWithRefsSchema });
export type ForkResponse = z.infer<typeof ForkResponseSchema>;

/** `GET /me/forks` 的分页响应。 */
export const ForkListResponseSchema = pageSchema(ForkWithRefsSchema);
export type ForkListResponse = z.infer<typeof ForkListResponseSchema>;
