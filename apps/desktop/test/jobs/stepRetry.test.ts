import { describe, expect, it } from 'vitest';
import { DEFAULT_STEP_AUTO_RETRIES, STEP_RETRY_BASE_DELAY_MS, decideStepFailure, isRetryableStepError } from '@/jobs/stepRetry';
import { LLMError } from '@/llm/types';

describe('哪些错误值得再试', () => {
  it('Key 不对 / 请求非法 / 上下文超长：再试也是白烧钱', () => {
    for (const kind of ['auth', 'bad_request', 'context_length'] as const) {
      expect(isRetryableStepError(new LLMError(kind, 'x')), kind).toBe(false);
    }
  });
  it('用户中止不算失败', () => {
    expect(isRetryableStepError(new LLMError('aborted', 'x'))).toBe(false);
  });
  it('限流 / 服务端 / 网络（含超时）可以再试', () => {
    for (const kind of ['rate_limit', 'server', 'network'] as const) {
      expect(isRetryableStepError(new LLMError(kind, 'x')), kind).toBe(true);
    }
  });
  it('模型这一次没发挥好（正文过短、JSON 没过校验）也值得再试', () => {
    expect(isRetryableStepError(new Error('模型返回的正文过短'))).toBe(true);
  });
});

describe('步骤失败后的决策（attempts 终于派上用场）', () => {
  it('默认再试两次，第三次失败才真的失败', () => {
    const of = (attempts: number) => decideStepFailure({ attempts, retryable: true });
    expect(of(1)).toEqual({ kind: 'retry', attempt: 1, delayMs: STEP_RETRY_BASE_DELAY_MS });
    expect(of(2)).toEqual({ kind: 'retry', attempt: 2, delayMs: STEP_RETRY_BASE_DELAY_MS * 2 });
    expect(of(3)).toEqual({ kind: 'fail' });
    expect(DEFAULT_STEP_AUTO_RETRIES).toBe(2);
  });

  it('不可重试的错误立刻失败，不管试了几次', () => {
    expect(decideStepFailure({ attempts: 1, retryable: false })).toEqual({ kind: 'fail' });
  });

  it('自动重试次数可配；配 0 就等于关掉', () => {
    expect(decideStepFailure({ attempts: 1, retryable: true, autoRetries: 0 })).toEqual({ kind: 'fail' });
    expect(decideStepFailure({ attempts: 4, retryable: true, autoRetries: 5 }).kind).toBe('retry');
  });

  it('退避指数增长但有上限', () => {
    const d = decideStepFailure({ attempts: 9, retryable: true, autoRetries: 20, maxDelayMs: 5000 });
    expect(d).toEqual({ kind: 'retry', attempt: 9, delayMs: 5000 });
  });
});
