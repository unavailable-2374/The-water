import type {
  ChatMessage,
  CompletionRequest,
  FetchLike,
  FinishReason,
  LLMErrorKind,
  LLMProvider,
  ProviderCaps,
  ProviderConfig,
  StreamEvent,
} from './types';
import { LLMError } from './types';
import { parseSSE } from './sse';
import { classifyHttpError, toLLMError } from './retry';

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_RESULT_TOOL = 'emit_result';

export function resolveMessagesUrl(baseUrl: string): string {
  let trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed === '') trimmed = ANTHROPIC_DEFAULT_BASE_URL;
  if (trimmed.endsWith('/v1/messages')) return trimmed;
  if (trimmed.endsWith('/v1')) return trimmed + '/messages';
  return trimmed + '/v1/messages';
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Hoist system messages into `system`, drop empty messages, merge consecutive same-role
 * messages (Anthropic requires strict alternation) and ensure the first turn is `user`.
 */
export function normalizeAnthropicMessages(messages: readonly ChatMessage[]): {
  system: string | undefined;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.content.trim() === '') continue;
    if (m.role === 'system') {
      systemParts.push(m.content);
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content += '\n\n' + m.content;
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  if (out.length === 0 || out[0]!.role !== 'user') {
    out.unshift({ role: 'user', content: '请开始。' });
  }
  return { system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, messages: out };
}

function mapStopReason(reason: unknown): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool';
    default:
      return 'other';
  }
}

export function classifyAnthropicErrorType(type: unknown, message: string): LLMErrorKind {
  switch (type) {
    case 'authentication_error':
    case 'permission_error':
      return 'auth';
    case 'rate_limit_error':
      return 'rate_limit';
    case 'overloaded_error':
    case 'api_error':
      return 'server';
    case 'invalid_request_error':
      return /prompt is too long|context|too many tokens/i.test(message) ? 'context_length' : 'bad_request';
    default:
      return 'bad_request';
  }
}

interface AnthropicStreamEvent {
  type?: string;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  content_block?: { type?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string | null };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

export class AnthropicProvider implements LLMProvider {
  readonly id: string;
  readonly model: string;
  readonly kind = 'anthropic' as const;
  readonly caps: ProviderCaps;
  readonly endpoint: string;

  constructor(
    private readonly config: ProviderConfig,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike,
  ) {
    this.id = config.id;
    this.model = config.model;
    this.caps = {
      contextWindow: config.contextWindow,
      maxOutputTokens: config.maxOutputTokens,
      jsonMode: config.jsonMode,
      cjkTokenRatio: 1.0,
    };
    this.endpoint = resolveMessagesUrl(config.baseUrl);
  }

  buildHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      ...this.config.extraHeaders,
    };
  }

  buildBody(req: CompletionRequest): Record<string, unknown> {
    const { system, messages } = normalizeAnthropicMessages(req.messages);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens,
      messages,
      temperature: req.temperature ?? this.config.temperature,
      stream: true,
    };
    if (system !== undefined) body.system = system;
    if (req.stop && req.stop.length > 0) body.stop_sequences = req.stop;
    if (req.json) {
      body.tools = [
        { name: ANTHROPIC_RESULT_TOOL, description: '输出结构化结果', input_schema: req.json.schema },
      ];
      body.tool_choice = { type: 'tool', name: ANTHROPIC_RESULT_TOOL };
    }
    return body;
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    const signal = req.signal;
    const jsonMode = req.json !== undefined;
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(this.buildBody(req)),
        signal,
      });
    } catch (err) {
      throw toLLMError(err, signal);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw classifyHttpError(res.status, text, res.headers);
    }
    if (!res.body) throw new LLMError('server', 'Empty response body', { status: res.status });

    let inputTokens = 0;
    let finishReason: FinishReason | null = null;
    let currentBlock: string | undefined;
    try {
      for await (const msg of parseSSE(res.body)) {
        const data = msg.data.trim();
        if (data === '') continue;
        let ev: AnthropicStreamEvent;
        try {
          ev = JSON.parse(data) as AnthropicStreamEvent;
        } catch {
          continue;
        }
        const type = ev.type ?? msg.event ?? '';
        switch (type) {
          case 'message_start': {
            const u = ev.message?.usage;
            if (u) {
              inputTokens = u.input_tokens ?? 0;
              yield { type: 'usage', inputTokens, outputTokens: u.output_tokens ?? 0 };
            }
            break;
          }
          case 'content_block_start':
            currentBlock = ev.content_block?.type;
            break;
          case 'content_block_delta': {
            const d = ev.delta;
            if (!d) break;
            if (d.type === 'text_delta' && typeof d.text === 'string') {
              // In structured mode only the tool input is the payload; stray prose would corrupt the JSON.
              if (!jsonMode || currentBlock === undefined) {
                if (d.text.length > 0) yield { type: 'delta', text: d.text };
              }
            } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
              if (d.partial_json.length > 0) yield { type: 'delta', text: d.partial_json };
            }
            break;
          }
          case 'content_block_stop':
            currentBlock = undefined;
            break;
          case 'message_delta': {
            if (ev.delta?.stop_reason) finishReason = mapStopReason(ev.delta.stop_reason);
            if (ev.usage) {
              yield {
                type: 'usage',
                inputTokens: ev.usage.input_tokens ?? inputTokens,
                outputTokens: ev.usage.output_tokens ?? 0,
              };
            }
            break;
          }
          case 'message_stop':
            yield { type: 'done', finishReason: finishReason ?? 'other' };
            return;
          case 'error': {
            const message = ev.error?.message ?? 'Unknown Anthropic stream error';
            throw new LLMError(classifyAnthropicErrorType(ev.error?.type, message), message, { raw: data });
          }
          default:
            break; // ping etc.
        }
      }
    } catch (err) {
      throw toLLMError(err, signal);
    }
    // Stream ended without message_stop — still terminate exactly once.
    yield { type: 'done', finishReason: finishReason ?? 'other' };
  }
}
