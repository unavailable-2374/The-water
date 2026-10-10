import {sumUsage} from '@/llm/types';
import { z } from 'zod';
import type { ChatMessage, CompletionRequest, LLMProvider, ProviderCaps, PromptSpec, Usage } from './types';
import { LLMError } from './types';
import { complete, completeWithRetry, growOutputBudget, type CompleteWithRetryOptions, type DeltaHandler } from './complete';
import type { RateGate } from './retry';
import { DEFAULT_JSON_REPAIR_ROUNDS } from './config';
import { estimateTokens } from './tokens';

// ---------------------------------------------------------------------------
// Lenient JSON extraction
// ---------------------------------------------------------------------------

const FENCE_RE = /```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/;

function stripFences(text: string): string {
  const m = FENCE_RE.exec(text);
  if (m && m[1] !== undefined && /[[{]/.test(m[1])) return m[1];
  return text;
}

function sliceToBrackets(text: string): string {
  const firstObj = text.indexOf('{');
  const firstArr = text.indexOf('[');
  let start: number;
  let closer: string;
  if (firstObj === -1 && firstArr === -1) return text;
  if (firstObj === -1 || (firstArr !== -1 && firstArr < firstObj)) {
    start = firstArr;
    closer = ']';
  } else {
    start = firstObj;
    closer = '}';
  }
  const end = text.lastIndexOf(closer);
  if (end === -1 || end < start) return text.slice(start);
  return text.slice(start, end + 1);
}

const FULLWIDTH_OPENERS: Record<string, string> = { '“': '”', '‘': '’' };

/**
 * Single pass over the text tracking JSON string state:
 * - outside strings: `“ ” ‘ ’` → `"`, `：` → `:`, `，` → `,`, trailing commas before `}`/`]` dropped
 * - inside strings: content is preserved verbatim (a `"` inside a full-width-quoted string is escaped)
 */
export function normalizeJsonText(text: string): string {
  let out = '';
  let inStr = false;
  let closer = '"';
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === '\\') {
        out += ch;
        escaped = true;
      } else if (ch === closer) {
        out += '"';
        inStr = false;
      } else if (ch === '"' && closer !== '"') {
        out += '\\"';
      } else {
        out += ch;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      closer = '"';
      out += ch;
    } else if (ch in FULLWIDTH_OPENERS) {
      inStr = true;
      closer = FULLWIDTH_OPENERS[ch]!;
      out += '"';
    } else if (ch === '”' || ch === '’') {
      // Stray closer used as an opener (e.g. ”foo”) — treat symmetrically.
      inStr = true;
      closer = ch;
      out += '"';
    } else if (ch === '：') {
      out += ':';
    } else if (ch === ',' || ch === '，') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      const next = text[j];
      if (next === '}' || next === ']') {
        i = j - 1; // drop trailing comma (and the whitespace after it)
        continue;
      }
      out += ',';
    } else {
      out += ch;
    }
  }
  return out;
}

/** Parse model output that is "almost JSON". Throws SyntaxError (message includes cleaned text). */
export function parseJsonLoose(text: string): unknown {
  let t = stripFences(text.trim());
  t = sliceToBrackets(t);
  t = normalizeJsonText(t).trim();
  try {
    return JSON.parse(t);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new SyntaxError(`${reason}\n--- cleaned text ---\n${t}`);
  }
}

// ---------------------------------------------------------------------------
// Schema-validated requests
// ---------------------------------------------------------------------------

export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

export function summarizeZodIssues(error: z.ZodError, max = 8): string {
  const parts = error.issues.slice(0, max).map((i) => {
    const path = i.path.length > 0 ? i.path.map(String).join('.') : '$';
    return `${path}: ${i.message}`;
  });
  if (error.issues.length > max) parts.push(`…共 ${error.issues.length} 个问题`);
  return parts.join('；');
}

export const JSON_ONLY_INSTRUCTION = '只输出一个 JSON 对象，不要任何解释或 Markdown 代码块。JSON 必须符合以下 JSON Schema：';

export function appendSchemaInstruction(messages: readonly ChatMessage[], schema: Record<string, unknown>): ChatMessage[] {
  const hint = `\n\n${JSON_ONLY_INSTRUCTION}\n${JSON.stringify(schema)}`;
  const out = messages.map((m) => ({ ...m }));
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]!.role === 'user') {
      out[i]!.content += hint;
      return out;
    }
  }
  out.push({ role: 'user', content: hint.trimStart() });
  return out;
}

/**
 * json_object / none 模式下 `appendSchemaInstruction` 会把完整 schema 拼进最后一条
 * user 消息，这部分 token 之前完全没算进上下文预算（§2.1 第 9 条）。调用方在
 * `buildContextBudget({ reserved })` 里预留它，避免长上下文直接 400。
 * json_schema / tool 模式由请求体承载 schema，不占 prompt，返回 0。
 */
export function schemaInstructionTokens(
  schema: Record<string, unknown>,
  caps: Pick<ProviderCaps, 'jsonMode' | 'cjkTokenRatio'>,
): number {
  if (caps.jsonMode !== 'json_object' && caps.jsonMode !== 'none') return 0;
  return estimateTokens(`\n\n${JSON_ONLY_INSTRUCTION}\n${JSON.stringify(schema)}`, caps.cjkTokenRatio);
}

/** `schemaInstructionTokens` 的 zod 版本：调用方一般手里只有 zod schema。 */
export function schemaReserveTokens(
  schema: z.ZodType,
  caps: Pick<ProviderCaps, 'jsonMode' | 'cjkTokenRatio'>,
): number {
  if (caps.jsonMode !== 'json_object' && caps.jsonMode !== 'none') return 0;
  return schemaInstructionTokens(zodToJsonSchema(schema), caps);
}

export interface RequestJsonOptions {
  signal?: AbortSignal;
  onDelta?: DeltaHandler;
  /** Set false to bypass RateGate + retry (default true). */
  retry?: boolean;
  gate?: RateGate;
  retryOptions?: Omit<CompleteWithRetryOptions, 'onDelta' | 'gate' | 'signal'>;
  /** 校验失败后的修复轮次（不含首轮），默认 config.ts 的 DEFAULT_JSON_REPAIR_ROUNDS。 */
  repairRounds?: number;
}

export interface RequestJsonResult<T> {
  value: T;
  raw: string;
  usage: Usage;
}

type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

function tryParse<T>(raw: string, schema: z.ZodType<T>): ParseOutcome<T> {
  let parsed: unknown;
  try {
    parsed = parseJsonLoose(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] ?? err.message : String(err);
    return { ok: false, error: `JSON 语法错误：${msg}` };
  }
  const result = schema.safeParse(parsed);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: summarizeZodIssues(result.error) };
}

/**
 * Request a schema-conforming JSON value. 校验失败后按 `repairRounds`（默认 2）轮
 * 在 temperature 0 下要求模型自纠；每轮都把上一轮的原文和错误摘要回灌，
 * 全部用尽仍不合法才抛 `LLMError('bad_request')` 并带上最后一次的原文。
 */
export async function requestJson<T>(
  provider: LLMProvider,
  spec: PromptSpec<T> & { schema: z.ZodType<T> },
  opts: RequestJsonOptions = {},
): Promise<RequestJsonResult<T>> {
  const jsonSchema = zodToJsonSchema(spec.schema);
  const mode = provider.caps.jsonMode;
  const messages =
    mode === 'json_object' || mode === 'none' ? appendSchemaInstruction(spec.messages, jsonSchema) : [...spec.messages];

  const baseReq: CompletionRequest = {
    messages,
    maxTokens: Math.min(spec.maxTokens,provider.caps.maxOutputTokens-(provider.caps.reasoningTokens ?? 0)),
    temperature: spec.temperature,
    json: { name: 'result', schema: jsonSchema },
    signal: opts.signal,
  };
  if(baseReq.maxTokens<=0) throw new LLMError('bad_request','推理预留必须小于最大输出预算');

  const run = async (req: CompletionRequest) => {
    try { return await (opts.retry === false
      ? complete(provider, req, opts.onDelta)
      : completeWithRetry(provider, req, { ...opts.retryOptions, signal: opts.signal, onDelta: opts.onDelta, gate: opts.gate })); }
    catch(error) { if(error instanceof LLMError) {error.usage=sumUsage(usage,error.usage ?? {inputTokens:0,outputTokens:0});error.providerId=provider.id;} throw error; }
  };

  const rounds = Math.max(0, Math.trunc(opts.repairRounds ?? DEFAULT_JSON_REPAIR_ROUNDS));
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };

  let result = await run({ ...baseReq });
  let attempts=1;
  let emptyExhaustions=result.finishReason==='length' && !result.text.trim() ? 1 : 0;
  if(result.usage.incomplete) usage.incomplete=true;
  usage.inputTokens += result.usage.inputTokens;
  usage.outputTokens += result.usage.outputTokens;
  let outcome:ParseOutcome<T> = result.finishReason==='length' ? {ok:false,error:'输出预算耗尽，JSON 未完整返回'}:tryParse(result.text, spec.schema);

  for (let round = 0; !outcome.ok && round < rounds; round++) {
    const truncated=result.finishReason==='length';
    if (truncated) {
      if (emptyExhaustions >= 2) {
        outcome={ok:false,error:'模型连续两次耗尽预算但未返回任何 JSON；请检查模型推理与输出格式配置，已停止继续扩大预算'};
        break;
      }
      const next=growOutputBudget(provider,{messages,maxTokens:baseReq.maxTokens});
      if(next<=baseReq.maxTokens) break;
      baseReq.maxTokens=next;
    }
    const repairMessages: ChatMessage[] = truncated ? messages : [
      ...messages,
      { role: 'assistant', content: result.text },
      { role: 'user', content: `上面的 JSON 无法通过校验，错误：${outcome.error}。请只输出修正后的完整 JSON，不要解释。` },
    ];
    attempts++;
    // Exhaustion is a budget retry, not a malformed-JSON repair: preserve sampling.
    result = await run({ ...baseReq, messages: repairMessages, temperature: truncated ? baseReq.temperature : 0 });
    emptyExhaustions=result.finishReason==='length' && !result.text.trim() ? emptyExhaustions+1 : 0;
    if(result.usage.incomplete) usage.incomplete=true;
  usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    outcome = result.finishReason==='length' ? {ok:false,error:'输出预算耗尽，JSON 未完整返回；请增加最大输出或推理预留'}:tryParse(result.text, spec.schema);
  }

  if (outcome.ok) return { value: outcome.value, raw: result.text, usage };

  throw new LLMError('bad_request', `${spec.label}: 模型输出的 JSON ${attempts} 次校验失败：${outcome.error}`, {
    raw: result.text, usage, providerId:provider.id,
  });
}
