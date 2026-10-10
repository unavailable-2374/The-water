import { z } from 'zod';

export const TopicTreeScopeSchema = z.strictObject({
  workId: z.string().min(1).max(200), branchId: z.string().min(1).max(200),
  channel: z.string().min(1).max(100),
  epoch: z.string().regex(/^[a-f0-9]{64}$/),
  chapterNo: z.number().int().min(0),
});
export const HarnessRequestSchema = z.strictObject({
  topicTree: TopicTreeScopeSchema.optional(),
  messages: z.array(z.strictObject({ role: z.enum(['system', 'user', 'assistant']), content: z.string().max(1_000_000) })).min(1).max(200),
  maxTokens: z.number().int().positive().max(262144),
  temperature: z.number().min(0).max(2).optional(),
  stop: z.array(z.string().max(200)).max(8).optional(),
  json: z.strictObject({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), schema: z.record(z.string(), z.unknown()) }).optional(),
  binding: z.strictObject({
    operationId: z.string().min(1).max(200),
    candidateVersionId: z.string().max(200).nullable(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    dependencyHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  }).optional(),
});
export type HarnessRequest = z.infer<typeof HarnessRequestSchema>;
export const HarnessStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);
export const HarnessEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('usage'), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), inputReported: z.boolean().optional(), outputReported: z.boolean().optional(), cumulative:z.boolean().optional() }),
  z.object({ type: z.literal('done'), finishReason: z.enum(['stop', 'length', 'tool', 'other']) }),
]);
export const HarnessTaskSchema = z.object({
  id: z.string(), requestHash: z.string(), status: HarnessStatusSchema,
  model: z.string(), provider: z.string(), binding: HarnessRequestSchema.shape.binding,
  createdAt: z.number(), expiresAt: z.number(),
  error: z.object({ kind: z.enum(['auth', 'rate_limit', 'context_length', 'server', 'network', 'aborted', 'bad_request']), message: z.string(), retryAfterMs: z.number().optional() }).nullable(),
  usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int() }).nullable(),
});
export type HarnessTask = z.infer<typeof HarnessTaskSchema>;
export const HarnessPageSchema = z.object({ task: HarnessTaskSchema, events: z.array(z.object({ seq: z.number().int().positive(), event: HarnessEventSchema })), hasMore: z.boolean() });
export const HarnessCapabilitiesSchema = z.object({
  enabled: z.boolean(), engine: z.enum(['pi', 'mastra']), protocolVersion: z.literal(1),
  provider: z.string(), model: z.string(),
  contextWindow: z.number().int(), maxOutputTokens: z.number().int(), reasoningTokens: z.number().int(),
  reasoningEffort: z.enum(['low', 'medium', 'high']), jsonMode: z.enum(['json_object', 'json_schema']),
  retentionHours: z.number(),
  topicTree: z.object({enabled:z.boolean(),version:z.string(),maxModelCalls:z.number().int().positive(),scopeRequired:z.literal(true)}).optional(),
});
