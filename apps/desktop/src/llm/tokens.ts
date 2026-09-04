import type { ChatMessage } from './types';

/** CJK Symbols/Punctuation + Kana + Han (U+3000–U+9FFF), CJK Compatibility Ideographs (U+F900–U+FAFF), Halfwidth/Fullwidth Forms (U+FF00–U+FFEF). */
const CJK_RE = /[　-鿿豈-﫿＀-￯]/g;

export function countCjkChars(text: string): number {
  const m = text.match(CJK_RE);
  return m ? m.length : 0;
}

/**
 * Rough token estimate: CJK chars count `cjkRatio` tokens each, everything else ~4 chars/token.
 * Anthropic tokenizes CJK closer to 1 token/char, OpenAI-family closer to 0.7.
 */
export function estimateTokens(text: string, cjkRatio = 0.7): number {
  if (!text) return 0;
  const cjk = countCjkChars(text);
  const other = text.length - cjk;
  return Math.ceil(cjk * cjkRatio + other / 4);
}

const PER_MESSAGE_OVERHEAD = 4;

export function estimateMessagesTokens(messages: readonly ChatMessage[], cjkRatio = 0.7): number {
  let total = 0;
  for (const m of messages) total += estimateTokens(m.content, cjkRatio) + PER_MESSAGE_OVERHEAD;
  return total;
}
