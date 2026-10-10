/**
 * Token 估算的**唯一**实现在 `prompts/estimate.ts`（按 Unicode script 匹配、按码点
 * 计数，代理对安全），这里只做转发 + 补一个「按消息列表估算」的便捷函数。
 *
 * 依赖方向是 transport → prompt，prompt 层仍然不依赖 transport 层（§4.6）。
 */
import type { ChatMessage } from './types';
import { countCjkAndOther, estimateTokens } from './estimate';

export {
  DEFAULT_CJK_TOKEN_RATIO,
  countCjkAndOther,
  estimateTokens,
  truncateHead,
  truncateTail,
} from './estimate';

/** CJK（含全角标点）字符数。 */
export function countCjkChars(text: string): number {
  return countCjkAndOther(text).cjk;
}

/** 每条消息的角色/分隔开销（经验值）。 */
const PER_MESSAGE_OVERHEAD = 4;

export function estimateMessagesTokens(messages: readonly ChatMessage[], cjkRatio = 0.7): number {
  let total = 0;
  for (const m of messages) total += estimateTokens(m.content, cjkRatio) + PER_MESSAGE_OVERHEAD;
  return total;
}
