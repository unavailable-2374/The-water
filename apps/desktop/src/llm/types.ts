/**
 * LLM provider abstraction. Everything above this file (jobs, UI) only talks to
 * `LLMProvider` and `LLMError`; concrete transports live in openaiCompatible.ts / anthropic.ts.
 */
import type { z } from 'zod';

export type ProviderKind = 'openai_compatible' | 'anthropic';
export type JsonMode = 'none' | 'json_object' | 'json_schema' | 'tool';

/** Row shape of the `llm_providers` table after mapping. */
export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  jsonMode: JsonMode;
  temperature: number;
  extraHeaders: Record<string, string>;
  /** Keychain account name, or `env:VAR_NAME` to read from process env at runtime. */
  secretRef: string;
  /** 首字节超时（毫秒）：发起请求到收到第一块数据。省略时用 config.ts 的默认值。 */
  firstByteTimeoutMs?: number;
  /** 流空闲超时（毫秒）：相邻两块数据之间的最大间隔。省略时用 config.ts 的默认值。 */
  idleTimeoutMs?: number;
  /** 代理地址，空字符串表示直连。 */
  proxyUrl?: string;
  /** 该供应商允许的并发请求数（预留给任务池，见 §2.1 第 8 条）。 */
  concurrency?: number;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export type ChatRole = 'system' | 'user' | 'assistant';
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface JsonSpec {
  name: string;
  /** JSON Schema (draft 2020-12 subset) produced by z.toJSONSchema. */
  schema: Record<string, unknown>;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  stop?: string[];
  json?: JsonSpec;
  signal?: AbortSignal;
}

export type FinishReason = 'stop' | 'length' | 'tool' | 'other';

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; finishReason: FinishReason };

export interface ProviderCaps {
  contextWindow: number;
  maxOutputTokens: number;
  jsonMode: JsonMode;
  /** Multiplier applied to CJK char count when estimating tokens. */
  cjkTokenRatio: number;
}

export interface LLMProvider {
  readonly id: string;
  readonly model: string;
  readonly kind: ProviderKind;
  readonly caps: ProviderCaps;
  stream(req: CompletionRequest): AsyncIterable<StreamEvent>;
}

export type LLMErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'context_length'
  | 'server'
  | 'network'
  | 'aborted'
  | 'bad_request';

export class LLMError extends Error {
  readonly kind: LLMErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly raw?: string;
  constructor(kind: LLMErrorKind, message: string, opts: { status?: number; retryAfterMs?: number; raw?: string; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'LLMError';
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.raw = opts.raw;
  }
  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'server' || this.kind === 'network';
  }
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionResult {
  text: string;
  usage: Usage;
  finishReason: FinishReason;
}

/** Fetch-compatible function; in the app it is `fetch` from @tauri-apps/plugin-http, in tests a fake. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A prompt template output: what a step feeds to `complete` / `requestJson`. */
export interface PromptSpec<T = unknown> {
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  schema?: z.ZodType<T>;
  /** Short label used in job logs / UI, e.g. "生成大纲". */
  label: string;
}
