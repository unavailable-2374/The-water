import type {
  CompletionRequest,
  FetchLike,
  FinishReason,
  LLMProvider,
  ProviderCaps,
  ProviderConfig,
  StreamEvent,
} from './types';
import { LLMError } from './types';
import { parseSSE } from './sse';
import { classifyHttpError } from './retry';
import { RequestTimer, guardedIteration, resolveTimeouts, type RequestTimeouts } from './timeout';

const CHAT_COMPLETIONS_SUFFIX = '/chat/completions';

/** `https://api.deepseek.com/` → `https://api.deepseek.com/chat/completions`; already-complete URLs are kept. */
export function resolveChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith(CHAT_COMPLETIONS_SUFFIX)) return trimmed;
  return trimmed + CHAT_COMPLETIONS_SUFFIX;
}

/**
 * OpenAI `json_schema` strict mode requires every object to list all properties as required
 * and to set `additionalProperties: false`. Returns true when the whole schema satisfies that.
 */
export function isStrictJsonSchema(node: unknown): boolean {
  if (!node || typeof node !== 'object') return true;
  if (Array.isArray(node)) return node.every(isStrictJsonSchema);
  const obj = node as Record<string, unknown>;
  const props = obj.properties;
  if (props && typeof props === 'object') {
    if (obj.additionalProperties !== false) return false;
    const keys = Object.keys(props as Record<string, unknown>);
    const required = Array.isArray(obj.required) ? (obj.required as unknown[]) : [];
    if (keys.some((k) => !required.includes(k))) return false;
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !isStrictJsonSchema(value)) return false;
  }
  return true;
}

function mapFinishReason(reason: unknown): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool';
    default:
      return 'other';
  }
}

interface ChatChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string; type?: string; code?: string | number } | string;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  readonly model: string;
  readonly kind = 'openai_compatible' as const;
  readonly caps: ProviderCaps;
  readonly endpoint: string;
  /** 首字节 / 流空闲超时，来自供应商配置（缺失时用默认值）。 */
  readonly timeouts: RequestTimeouts;

  constructor(
    private readonly config: ProviderConfig,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike,
  ) {
    this.id = config.id;
    this.model = config.model;
    this.timeouts = resolveTimeouts(config);
    this.caps = {
      contextWindow: config.contextWindow,
      maxOutputTokens: config.maxOutputTokens,
      jsonMode: config.jsonMode,
      cjkTokenRatio: 0.7,
    };
    this.endpoint = resolveChatCompletionsUrl(config.baseUrl);
  }

  buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...this.config.extraHeaders,
    };
  }

  buildBody(req: CompletionRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: req.maxTokens,
      temperature: req.temperature ?? this.config.temperature,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.stop && req.stop.length > 0) body.stop = req.stop;
    if (req.json) {
      if (this.caps.jsonMode === 'json_schema') {
        const json_schema: Record<string, unknown> = { name: req.json.name, schema: req.json.schema };
        if (isStrictJsonSchema(req.json.schema)) json_schema.strict = true;
        body.response_format = { type: 'json_schema', json_schema };
      } else if (this.caps.jsonMode === 'json_object') {
        body.response_format = { type: 'json_object' };
      }
      // 'none' / 'tool': the prompt carries the schema instruction.
    }
    return body;
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    const signal = req.signal;
    const timer = new RequestTimer(this.timeouts, signal);
    timer.start();

    let res: Response;
    try {
      res = await timer.race(
        this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(this.buildBody(req)),
          signal: timer.signal,
        }),
      );
      if (!res.ok) {
        const text = await timer.race(res.text().catch(() => ''));
        throw classifyHttpError(res.status, text, res.headers);
      }
      if (!res.body) throw new LLMError('server', 'Empty response body', { status: res.status });
    } catch (err) {
      timer.dispose();
      throw timer.toError(err, signal);
    }

    let finishReason: FinishReason | null = null;
    try {
      for await (const msg of guardedIteration(parseSSE(res.body), timer)) {
        const data = msg.data.trim();
        if (data === '[DONE]') break;
        if (data === '') continue;
        let chunk: ChatChunk;
        try {
          chunk = JSON.parse(data) as ChatChunk;
        } catch {
          continue; // tolerate keep-alive garbage
        }
        if (chunk.error) {
          const message =
            typeof chunk.error === 'string' ? chunk.error : chunk.error.message ?? JSON.stringify(chunk.error);
          throw new LLMError('server', message, { raw: data });
        }
        const choice = chunk.choices?.[0];
        const content = choice?.delta?.content;
        if (typeof content === 'string' && content.length > 0) yield { type: 'delta', text: content };
        if (choice?.finish_reason) finishReason = mapFinishReason(choice.finish_reason);
        if (chunk.usage) {
          yield {
            type: 'usage',
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
          };
        }
      }
    } catch (err) {
      throw timer.toError(err, signal);
    } finally {
      timer.dispose();
    }
    yield { type: 'done', finishReason: finishReason ?? 'other' };
  }
}
