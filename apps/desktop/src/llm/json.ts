import { z } from 'zod';
import type { ChatMessage, CompletionRequest, LLMProvider, PromptSpec, Usage } from './types';
import { LLMError } from './types';
import { complete, completeWithRetry, type CompleteWithRetryOptions, type DeltaHandler } from './complete';
import type { RateGate } from './retry';

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

export interface RequestJsonOptions {
  signal?: AbortSignal;
  onDelta?: DeltaHandler;
  /** Set false to bypass RateGate + retry (default true). */
  retry?: boolean;
  gate?: RateGate;
  retryOptions?: Omit<CompleteWithRetryOptions, 'onDelta' | 'gate' | 'signal'>;
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
 * Request a schema-conforming JSON value. On validation failure runs one repair round at
 * temperature 0; a second failure throws `LLMError('bad_request')` carrying the raw text.
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
    maxTokens: spec.maxTokens,
    temperature: spec.temperature,
    json: { name: 'result', schema: jsonSchema },
    signal: opts.signal,
  };

  const run = (req: CompletionRequest) =>
    opts.retry === false
      ? complete(provider, req, opts.onDelta)
      : completeWithRetry(provider, req, { ...opts.retryOptions, signal: opts.signal, onDelta: opts.onDelta, gate: opts.gate });

  const first = await run(baseReq);
  const usage: Usage = { ...first.usage };
  const outcome1 = tryParse(first.text, spec.schema);
  if (outcome1.ok) return { value: outcome1.value, raw: first.text, usage };

  const repairMessages: ChatMessage[] = [
    ...messages,
    { role: 'assistant', content: first.text },
    { role: 'user', content: `上面的 JSON 无法通过校验，错误：${outcome1.error}。请只输出修正后的完整 JSON，不要解释。` },
  ];
  const second = await run({ ...baseReq, messages: repairMessages, temperature: 0 });
  usage.inputTokens += second.usage.inputTokens;
  usage.outputTokens += second.usage.outputTokens;
  const outcome2 = tryParse(second.text, spec.schema);
  if (outcome2.ok) return { value: outcome2.value, raw: second.text, usage };

  throw new LLMError('bad_request', `${spec.label}: 模型输出的 JSON 两次校验失败：${outcome2.error}`, {
    raw: second.text,
  });
}
