/**
 * 续写复用已生成文本（§2.1 第 4 条）。
 *
 * 暂停 / 崩溃时，runner 已经把流式收到的半章存进了 `job_steps.partial_text`，
 * 但恢复时整步从头重跑，既浪费时间又重复计费。这里把这段半成品当作**续写种子**：
 * 在原有消息之后追加「以下是已写部分，请从此处继续」的说明，再追加一条 assistant
 * 消息把半成品塞回去（prefill），模型于是从断点往下写。
 *
 * 之所以用「追加 assistant 前缀消息」而不是改提示词模板：`llm/prompts/**` 不归本模块，
 * 这样做不需要动任何模板文件，也不影响首次生成的提示词。
 *
 * 纯函数，无副作用。
 */
import type { ChatMessage } from '@/llm/types';

/** 短于这个长度的半成品不值得复用（提示词开销比省下的还多）。 */
export const MIN_RESUME_SEED_CHARS = 120;

/** 判断「模型没听懂、又从头写了一遍」时比对的前缀长度。 */
export const RESTART_PROBE_CHARS = 24;

const SENTENCE_ENDINGS = ['。', '！', '？', '…', '”', '’', '』', '」', '.', '!', '?', '\n'];

/**
 * 把半成品截到最后一个句末，避免让模型从半个句子接着写。
 * 找不到句末（例如整段没有标点）时原样返回。
 */
export function trimToSentenceEnd(text: string): string {
  const s = text.replace(/\s+$/, '');
  if (!s) return '';
  let cut = -1;
  for (const mark of SENTENCE_ENDINGS) {
    const i = s.lastIndexOf(mark);
    if (i > cut) cut = i;
  }
  if (cut < 0) return s;
  return s.slice(0, cut + 1).replace(/\s+$/, '');
}

export interface ResumeSeed {
  /** 要发给模型的消息（原消息 + 续写说明 + assistant 前缀）。 */
  messages: ChatMessage[];
  /** 已写好的部分；拼最终结果时要放在模型新产出的前面。为空表示没有续写。 */
  prefix: string;
}

export const RESUME_INSTRUCTION =
  '上一次生成到一半被中断了。下面这条 assistant 消息是你**已经写好的部分**，请直接从它的结尾继续往下写：\n'
  + '- 不要重新开头，不要复述或改写已写的内容；\n'
  + '- 不要加「（续）」之类的标记，也不要重复章节标题；\n'
  + '- 只输出接下来的正文，写到本章自然结束为止。';

/**
 * 给一组消息挂上续写种子。半成品太短或为空时原样返回（prefix 为空字符串）。
 */
export function withResumeSeed(
  messages: readonly ChatMessage[],
  partial: string | null | undefined,
  opts: { minChars?: number } = {},
): ResumeSeed {
  const minChars = opts.minChars ?? MIN_RESUME_SEED_CHARS;
  const prefix = trimToSentenceEnd((partial ?? '').trim());
  if (prefix.length < minChars) return { messages: [...messages], prefix: '' };
  return {
    messages: [...messages, { role: 'user', content: RESUME_INSTRUCTION }, { role: 'assistant', content: prefix }],
    prefix,
  };
}

/** 只要种子文本本身（够长才返回，否则空串）。 */
export function resumePrefix(partial: string | null | undefined, minChars: number = MIN_RESUME_SEED_CHARS): string {
  return withResumeSeed([], partial, { minChars }).prefix;
}

/**
 * 拼接「已写部分 + 模型续写」。两种异常情况要挡住：
 *   - 模型没听懂又从头写了一遍 → 直接采用它的新文本；
 *   - 模型把结尾重复了一小段 → 去掉重叠部分。
 */
export function joinResumed(prefix: string, continuation: string): string {
  const head = continuation.replace(/^\s+/, '');
  if (!prefix) return head;
  if (!head) return prefix;
  const probe = prefix.slice(0, Math.min(RESTART_PROBE_CHARS, prefix.length));
  if (probe.length >= 8 && head.startsWith(probe)) return head;
  // 去掉「续写开头与已写结尾」的重叠（最多比对 200 字）。
  const maxOverlap = Math.min(200, prefix.length, head.length);
  for (let n = maxOverlap; n >= 12; n--) {
    if (prefix.endsWith(head.slice(0, n))) return prefix + head.slice(n);
  }
  const needsBreak = !/[\s\n]$/.test(prefix) && !/^[\s\n]/.test(continuation);
  return needsBreak ? `${prefix}\n${head}` : prefix + head;
}
