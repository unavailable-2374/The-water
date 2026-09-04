/**
 * 步骤级重试策略（§2.1 第 6 条）。
 *
 * 原来任一步骤失败就整个任务 failed，`job_steps.attempts` 这一列只用来在界面上
 * 显示「×2」，从没参与过重试决策。这里补上：
 *   - 可自动重试的错误（网络抖动、模型没按 schema 输出、正文过短……）在步骤级
 *     再试若干次（默认 2 次），用的就是 attempts 列；
 *   - 明确不该重试的错误（Key 不对、请求非法、上下文超长）立刻失败，
 *     免得白烧三遍钱；
 *   - 用户中止不算失败。
 *
 * 纯函数，方便单测覆盖状态机。
 */
import { LLMError } from '@/llm/types';

/** 首次失败之后额外自动重试的次数。 */
export const DEFAULT_STEP_AUTO_RETRIES = 2;
/** 自动重试之间的基础退避（指数增长）。 */
export const STEP_RETRY_BASE_DELAY_MS = 1500;
export const STEP_RETRY_MAX_DELAY_MS = 30_000;

/** 这些错误重试多少次都是同样的结果。 */
const FATAL_LLM_KINDS = new Set(['auth', 'bad_request', 'context_length']);

export function isRetryableStepError(err: unknown): boolean {
  if (err instanceof LLMError) {
    if (err.kind === 'aborted') return false;
    return !FATAL_LLM_KINDS.has(err.kind);
  }
  // 非 LLM 错误（JSON 校验没过、正文过短、圣经合并失败……）大多是模型这一次没发挥好，值得再试。
  return true;
}

export type StepFailureDecision =
  | { kind: 'retry'; attempt: number; delayMs: number }
  | { kind: 'fail' };

export interface StepFailureInput {
  /** `stepStarted` 之后的 attempts 值：第一次失败时为 1。 */
  attempts: number;
  /** 允许的自动重试次数。 */
  autoRetries?: number;
  retryable: boolean;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export function decideStepFailure(input: StepFailureInput): StepFailureDecision {
  const autoRetries = Math.max(0, Math.trunc(input.autoRetries ?? DEFAULT_STEP_AUTO_RETRIES));
  if (!input.retryable) return { kind: 'fail' };
  const attempts = Math.max(1, Math.trunc(input.attempts));
  if (attempts > autoRetries) return { kind: 'fail' };
  const base = input.baseDelayMs ?? STEP_RETRY_BASE_DELAY_MS;
  const max = input.maxDelayMs ?? STEP_RETRY_MAX_DELAY_MS;
  return { kind: 'retry', attempt: attempts, delayMs: Math.min(max, base * 2 ** (attempts - 1)) };
}
