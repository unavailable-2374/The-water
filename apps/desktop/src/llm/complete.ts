import type { CompletionRequest, CompletionResult, FinishReason, LLMProvider, Usage } from './types';
import { LLMError, sumUsage } from './types';
import { getRateGate, withRetry, type RateGate, type RetryOptions } from './retry';
import { estimateMessagesTokens } from './tokens';

export type DeltaHandler = (text: string, accumulated: string) => void;

/** Output text and reasoning share one provider cap; all retry paths use this rule. */
export function growOutputBudget(
  provider: Pick<LLMProvider, 'caps'>,
  req: Pick<CompletionRequest, 'messages' | 'maxTokens'>,
): number {
  const reasoning = provider.caps.reasoningTokens ?? 0;
  const available = Math.min(
    provider.caps.maxOutputTokens - reasoning,
    provider.caps.contextWindow -
      estimateMessagesTokens(req.messages, provider.caps.cjkTokenRatio) -
      reasoning -
      1500,
  );
  return Math.max(req.maxTokens, Math.min(available, Math.max(req.maxTokens * 2, req.maxTokens + reasoning)));
}

/** Drain a provider stream into a single result. */
export async function complete(
  provider: LLMProvider,
  req: CompletionRequest,
  onDelta?: DeltaHandler,
): Promise<CompletionResult> {
  let text = '';
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let finishReason: FinishReason = 'other';
  try {
    for await (const ev of provider.stream(req)) {
      switch (ev.type) {
        case 'delta':
          if (ev.text) {
            text += ev.text;
            onDelta?.(ev.text, text);
          }
          break;
        case 'usage':
          if(ev.cumulative && (ev.inputReported===false||ev.outputReported===false)) usage.incomplete=true;
          // Providers may report input/output in separate events; latest non-zero wins.
          if (ev.inputTokens > 0) usage.inputTokens = ev.inputTokens;
          if (ev.outputTokens > 0) usage.outputTokens = ev.outputTokens;
          break;
        case 'done':
          finishReason = ev.finishReason;
          break;
      }
    }
  } catch (error) {
    if (error instanceof LLMError) {
      error.usage = {
        ...(usage.incomplete||error.usage?.incomplete?{incomplete:true as const}:{}),
        inputTokens: Math.max(usage.inputTokens, error.usage?.inputTokens ?? 0),
        outputTokens: Math.max(usage.outputTokens, error.usage?.outputTokens ?? 0),
      };
      error.providerId = provider.id;
    }
    throw error;
  }
  return { text, usage, finishReason };
}

export interface CompleteWithRetryOptions extends RetryOptions {
  onDelta?: DeltaHandler;
  /** Prose must not silently accept a response cut off by the output limit. */
  requireComplete?: boolean;
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
  const { onDelta, requireComplete, gate: _gate, ...retryOpts } = opts;
  void _gate;
  const spent: Usage = { inputTokens: 0, outputTokens: 0 };
  let proseBudget = req.maxTokens,
    budgetRetries = 0, emptyExhaustions = 0;
  try {
    return await withRetry(
      async () => {
        for (;;) {
          await gate.acquire(signal);
          try {
            const result = await complete(provider, { ...req, maxTokens: proseBudget, signal }, onDelta);
            emptyExhaustions=result.finishReason==='length' && !result.text.trim() ? emptyExhaustions+1 : 0;
            if (requireComplete && emptyExhaustions >= 2)
              throw new LLMError('bad_request', '模型连续两次耗尽预算但未返回正文；请检查模型推理与输出配置，已停止继续扩大预算', {usage:result.usage,providerId:provider.id});
            const nextBudget = growOutputBudget(provider, { ...req, maxTokens: proseBudget });
            if (
              requireComplete &&
              result.finishReason === 'length' &&
              proseBudget < nextBudget &&
              budgetRetries < 2
            ) {
              if(result.usage.incomplete) spent.incomplete=true;
              spent.inputTokens += result.usage.inputTokens;
              spent.outputTokens += result.usage.outputTokens;
              // Reasoning and text share the provider's output cap. Retry the whole response,
              // never append a truncated fragment or accept it as a complete manuscript.
              proseBudget = nextBudget;
              budgetRetries++;
              continue;
            }
            if (requireComplete && result.finishReason === 'length')
              throw new LLMError(
                'bad_request',
                '正文输出预算耗尽，请增加最大输出预算后重试；未提交截断正文',
                { usage: result.usage, providerId: provider.id },
              );
            return {
              ...result,
              usage: {
                ...(spent.incomplete||result.usage.incomplete?{incomplete:true as const}:{}),
                inputTokens: spent.inputTokens + result.usage.inputTokens,
                outputTokens: spent.outputTokens + result.usage.outputTokens,
              },
            };
          } catch (err) {
            if (err instanceof LLMError && err.usage) {
              Object.assign(spent,sumUsage(spent,err.usage));

            }
            if (err instanceof LLMError && err.kind === 'rate_limit') gate.reportRateLimit(err.retryAfterMs);
            throw err;
          }
        }
      },
      { ...retryOpts, signal },
    );
  } catch (error) {
    if (error instanceof LLMError) {
      error.usage = spent;
      error.providerId = provider.id;
    }
    throw error;
  }
}
