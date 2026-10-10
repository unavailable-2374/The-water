import { sha256Hex, type HarnessRequest } from '@the-water/shared';
import type { z } from 'zod';
import type { HarnessCapabilitiesSchema } from '@the-water/shared';
import { ApiError, type PublicApi } from '@/sync/api';
import { getClient } from '@/sync/account';
import { getAccount } from '@/sync/session';
import { getDb } from '@/db/db';
import { getSetting, setSetting } from '@/db/repos/settingsRepo';
import { LLMError, type CompletionRequest, type LLMProvider, type ProviderConfig, type StreamEvent } from './types';

export const SERVER_PROVIDER_ID = 'server:lunaroute';
type Caps = z.infer<typeof HarnessCapabilitiesSchema>;
interface Pending { key: string; taskId?: string; createdAt?: number }
export interface PendingStore {
  get(key: string): Promise<Pending | null>;
  set(key: string, value: Pending): Promise<void>;
  delete(key: string): Promise<void>;
}
const localPending: PendingStore = {
  get: key => getSetting<Pending | null>(key, null),
  set: setSetting,
  delete: async key => { await getDb().execute('DELETE FROM settings WHERE key=?', [key]); },
};
function transportError(error: unknown): LLMError {
  if (error instanceof LLMError) return error;
  if (error instanceof ApiError) return new LLMError(error.status === 401 || error.status === 403 ? 'auth' : error.status === 429 ? 'rate_limit' : error.status === 0 ? 'network' : error.status >= 500 ? 'server' : 'bad_request', error.message, { status: error.status });
  return new LLMError('network', error instanceof Error ? error.message : '模型服务连接失败');
}
const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(new LLMError('aborted', '已取消')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
});

/** Polling replays persisted events, so WebView disconnects never own the remote task lifetime. */
export class ServerProvider implements LLMProvider {
  readonly id = SERVER_PROVIDER_ID;
  readonly kind = 'openai_compatible' as const;
  readonly model: string;
  readonly caps;
  private readonly retentionMs: number;
  constructor(private readonly client: PublicApi, capabilities: Caps, private readonly ownerId: string,
    private readonly pending: PendingStore = localPending, private readonly pollMs = 350) {
    this.model = capabilities.model;
    this.retentionMs = capabilities.retentionHours * 3600000;
    this.caps = { contextWindow: capabilities.contextWindow, maxOutputTokens: capabilities.maxOutputTokens,
      reasoningTokens: capabilities.reasoningTokens, jsonMode: capabilities.jsonMode, cjkTokenRatio: 0.7 };
  }
  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    const body: HarnessRequest = { ...(req.topicTree ? {topicTree:req.topicTree}:{}), messages: req.messages, maxTokens: req.maxTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.stop ? { stop: req.stop } : {}), ...(req.json ? { json: req.json } : {}), ...(req.binding ? { binding: req.binding } : {}) };
    const fingerprint = await sha256Hex(JSON.stringify({ server: this.client.baseUrl, owner: this.ownerId, model: this.model, body }));
    const slot = `harness:pending:${fingerprint}`;
    let saved = await this.pending.get(slot);
    if (saved?.createdAt && Date.now() - saved.createdAt >= this.retentionMs) {
      await this.pending.delete(slot);
      throw new LLMError('bad_request', '未确认的模型请求已过服务保留期；结果未知，请明确重试');
    }
    saved ??= { key: crypto.randomUUID(), createdAt: Date.now() };
    await this.pending.set(slot, saved); // Persist before POST; uncertain acknowledgement retries reuse this exact key.
    let taskId = saved.taskId, after = 0;
    const signal = () => req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
    try {
      if (!taskId) {
        const task = await this.client.createWritingTask(body, saved.key, signal());
        taskId = task.id;
        await this.pending.set(slot, { ...saved, taskId });
      }
      let finish: Extract<StreamEvent, { type: 'done' }> | undefined;
      for (;;) {
        req.signal?.throwIfAborted();
        const page = await this.client.writingTask(taskId, after, signal());
        const sameBinding = page.task.binding?.operationId === body.binding?.operationId &&
          page.task.binding?.candidateVersionId === body.binding?.candidateVersionId &&
          page.task.binding?.contentHash === body.binding?.contentHash && page.task.binding?.dependencyHash === body.binding?.dependencyHash;
        if (page.task.id !== taskId || page.task.model !== this.model || !sameBinding) throw new LLMError('bad_request', '模型服务结果与请求版本绑定不匹配');
        for (const item of page.events) {
          if (item.seq !== after + 1) throw new LLMError('bad_request', '模型服务输出缺块；未提交正文');
          after = item.seq;
          if (item.event.type === 'done') finish = item.event;
          else yield item.event;
        }
        if (page.hasMore) continue;
        if (page.task.status === 'completed') {
          if (!finish) throw new LLMError('bad_request', '模型服务结果不完整；未提交正文');
          await this.pending.delete(slot);
          yield finish;
          return;
        }
        if (['failed', 'cancelled', 'interrupted'].includes(page.task.status)) {
          await this.pending.delete(slot);
          throw new LLMError(page.task.status === 'interrupted' ? 'bad_request' : page.task.error?.kind ?? 'server',
            page.task.error?.message ?? '模型任务失败', { retryAfterMs: page.task.error?.retryAfterMs, usage: page.task.usage ?? undefined });
        }
        await pause(this.pollMs, req.signal);
      }
    } catch (error) {
      if (req.signal?.aborted) {
        if (taskId) {
          try { await this.client.cancelWritingTask(taskId, AbortSignal.timeout(5000)); await this.pending.delete(slot); }
          catch { /* Unknown cancel acknowledgement: keep the id for reconnect, never pretend it was cancelled. */ }
        }
        throw new LLMError('aborted', '已取消');
      }
      // A lost/expired login does not tell us whether the paid upstream task finished.
      // Keep its key until re-authentication can read the same owner's task.
      if (error instanceof ApiError && !error.retryable && error.status !== 401 && error.status !== 403 ||
          error instanceof LLMError && !error.retryable && error.kind !== 'auth') await this.pending.delete(slot);
      throw transportError(error);
    }
  }
}

export async function serverProvider(): Promise<{ config: ProviderConfig; provider: LLMProvider }> {
  const client = await getClient();
  const account = await getAccount();
  if (!client || !account) throw new LLMError('auth', '请先在设置中登录云端账号；模型服务由开发者提供，无需供应商 API Key');
  const caps = await client.writingCapabilities(AbortSignal.timeout(15000)).catch(error => { throw transportError(error); });
  if (!caps.enabled) throw new LLMError('bad_request', '开发者尚未启用模型服务，请联系开发者');
  return { config: { id: SERVER_PROVIDER_ID, name: 'Lunaroute · Server', kind: 'openai_compatible', baseUrl: client.baseUrl,
    model: caps.model, contextWindow: caps.contextWindow, maxOutputTokens: caps.maxOutputTokens, reasoningTokens: caps.reasoningTokens,
    reasoningEffort: caps.reasoningEffort, jsonMode: caps.jsonMode, temperature: 0.8, extraHeaders: {}, secretRef: '',
    isDefault: true, createdAt: 0, updatedAt: 0 }, provider: new ServerProvider(client, caps, account.userId) };
}
