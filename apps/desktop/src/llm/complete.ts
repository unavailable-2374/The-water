import type { CompletionRequest, CompletionResult, FinishReason, LLMProvider, Usage } from './types';
import { LLMError } from './types';
import { getRateGate, withRetry, type RateGate, type RetryOptions } from './retry';

export type DeltaHandler = (text: string, accumulated: string) => void;

/** Drain a provider stream into a single result. */
export async function complete(
  provider: LLMProvider,
  req: CompletionRequest,
  onDelta?: DeltaHandler,
): Promise<CompletionResult> {
  let text = '';
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let finishReason: FinishReason = 'other';
  for await (const ev of provider.stream(req)) {
    switch (ev.type) {
      case 'delta':
        if (ev.text) {
          text += ev.text;
          onDelta?.(ev.text, text);
        }
        break;
      case 'usage':
        // Providers may report input/output in separate events; latest non-zero wins.
        if (ev.inputTokens > 0) usage.inputTokens = ev.inputTokens;
        if (ev.outputTokens > 0) usage.outputTokens = ev.outputTokens;
        break;
      case 'done':
        finishReason = ev.finishReason;
        break;
    }
  }
  return { text, usage, finishReason };
}

export interface CompleteWithRetryOptions extends RetryOptions {
  onDelta?: DeltaHandler;
  /** Override the per-provider gate (tests). */
  gate?: RateGate;
}

/**
 * `complete` wrapped in the provider's RateGate and retry policy. Each attempt re-acquires
 * the gate so a 429 cooldown applies to the retry. `onDelta`'s accumulated text restarts on retry.
 */
export async function completeWithRetry(
  provider: LLMProvider,
  req: CompletionRequest,
  opts: CompleteWithRetryOptions = {},
): Promise<CompletionResult> {
  const gate = opts.gate ?? getRateGate(provider.id);
  const signal = opts.signal ?? req.signal;
  const { onDelta, gate: _gate, ...retryOpts } = opts;
  void _gate;
  return withRetry(
    async () => {
      await gate.acquire(signal);
      try {
        return await complete(provider, { ...req, signal }, onDelta);
      } catch (err) {
        if (err instanceof LLMError && err.kind === 'rate_limit') gate.reportRateLimit(err.retryAfterMs);
        throw err;
      }
    },
    { ...retryOpts, signal },
  );
}
