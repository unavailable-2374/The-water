/**
 * 上下文预算自动降档（§2.1 第 5 条）。
 *
 * `contextWindow` 是用户手填的数字，填大了就会在真正发请求时被供应商以 400
 * 回绝（`LLMError.kind === 'context_length'`）。这里提供一个「带预算重试」的包装：
 * 调用方把「组装提示词 → 发请求」整段逻辑写成一个以预算系数为参数的函数，
 * 命中 context_length 时自动把系数缩一档（默认 ×0.7）重跑一次，两次都失败才上抛。
 *
 * 之所以做成回调而不是在 `complete` 里重试：只有调用方（步骤）才拿得到预算，
 * 也只有它能用更小的预算重新裁剪上下文——传输层手里只有已经拼好的 messages。
 */
import { LLMError } from './types';
import { CONTEXT_DOWNGRADE_FACTOR, CONTEXT_DOWNGRADE_MAX_ATTEMPTS } from './config';

/** 第 `step` 档的预算系数：0 档 = 1，1 档 = 0.7，2 档 = 0.49…… */
export function downgradeScale(step: number, factor: number = CONTEXT_DOWNGRADE_FACTOR): number {
  return factor ** Math.max(0, step);
}

export interface ContextDowngradeOptions {
  /** 含首次在内的总尝试次数，默认 2。 */
  attempts?: number;
  /** 每档的缩放系数，默认 0.7。 */
  factor?: number;
  /** 降档时的回调，用于把「上下文已缩减，正在重试」写进任务日志。 */
  onDowngrade?: (info: { attempt: number; nextScale: number; error: LLMError }) => void;
}

export function isContextLengthError(err: unknown): err is LLMError {
  return err instanceof LLMError && err.kind === 'context_length';
}

/**
 * 以「上下文预算系数」执行 `run`；命中 context_length 时缩一档重试。
 * 其它错误（含超时/限流）原样上抛，交给 `withRetry` 处理，避免两套重试互相叠加。
 */
export async function withContextDowngrade<T>(
  run: (scale: number, attempt: number) => Promise<T>,
  opts: ContextDowngradeOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.trunc(opts.attempts ?? CONTEXT_DOWNGRADE_MAX_ATTEMPTS));
  const factor = opts.factor ?? CONTEXT_DOWNGRADE_FACTOR;
  for (let attempt = 0; ; attempt++) {
    try {
      return await run(downgradeScale(attempt, factor), attempt);
    } catch (err) {
      if (!isContextLengthError(err) || attempt + 1 >= attempts) throw err;
      opts.onDowngrade?.({ attempt, nextScale: downgradeScale(attempt + 1, factor), error: err });
    }
  }
}
