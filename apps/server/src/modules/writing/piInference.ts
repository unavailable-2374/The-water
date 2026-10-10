import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AssistantMessage, Model, Usage } from '@earendil-works/pi-ai';
import { LLMError, type CompletionRequest, type LLMProvider, type StreamEvent } from '@the-water/llm/types';

// Pi requires numeric usage/prices. NaN explicitly means unknown inside the
// ephemeral Agent transcript; never publish it as a measured zero or free call.
// Public usage comes exclusively from the original provider usage events.
const unknownUsage = (): Usage => ({
  input: NaN, output: NaN, cacheRead: NaN, cacheWrite: NaN, totalTokens: NaN,
  cost: { input: NaN, output: NaN, cacheRead: NaN, cacheWrite: NaN, total: NaN },
});

/** Real Pi Agent loop with a fixed-provider adapter; one inference per durable task. */
export async function runPiInference(
  provider: LLMProvider,
  request: CompletionRequest,
  emit: (event: StreamEvent) => void,
) {
  const model: Model<'openai-completions'> = {
    id: provider.model, name: provider.model, api: 'openai-completions',
    provider: 'lunaroute', baseUrl: 'https://gw.lunaroute.com/v1', input: ['text'],
    reasoning: true, contextWindow: provider.caps.contextWindow, maxTokens: provider.caps.maxOutputTokens,
    cost: { input: NaN, output: NaN, cacheRead: NaN, cacheWrite: NaN },
  };
  const messages: AgentMessage[] = request.messages.map((message): AgentMessage => message.role === 'assistant'
    ? { role: 'assistant', content: [{ type: 'text', text: message.content }], api: model.api,
        provider: model.provider, model: model.id, usage: unknownUsage(), stopReason: 'stop', timestamp: Date.now() }
    : { role: message.role as 'system' | 'user', content: message.content, timestamp: Date.now() });
  let calls = 0;
  let failure: unknown;
  let finish: Extract<StreamEvent, { type: 'done' }> | undefined;
  const agent = new Agent({
    initialState: { model, tools: [] },
    // Preserve exact submitted context, including system messages, order and history.
    // No implicit compaction, injected instructions or extra model turns.
    prepareRequest: async () => ({ context: { messages } }),
    finishTurn: async () => ({ action: 'end' }),
    streamFn: (_model, _context, options) => {
      const stream = new AssistantMessageEventStream();
      const message: AssistantMessage = {
        role: 'assistant', content: [{ type: 'text', text: '' }], api: model.api,
        provider: model.provider, model: model.id, usage: unknownUsage(), stopReason: 'pending', timestamp: Date.now(),
      };
      void (async () => {
        try {
          if (++calls !== 1) throw new LLMError('bad_request', 'Pi attempted an additional model turn');
          const signals = [request.signal, options?.signal].filter((s): s is AbortSignal => !!s);
          const signal = signals.length ? AbortSignal.any(signals) : undefined;
          stream.push({ type: 'start', partial: message });
          stream.push({ type: 'text_start', contentIndex: 0, partial: message });
          for await (const event of provider.stream({ ...request, signal })) {
            if (event.type === 'delta') {
              (message.content[0] as { type: 'text'; text: string }).text += event.text;
              stream.push({ type: 'text_delta', contentIndex: 0, delta: event.text, partial: message });
            } else if (event.type === 'usage') {
              if (event.inputReported !== false) message.usage.input = event.inputTokens;
              if (event.outputReported !== false) message.usage.output = event.outputTokens;
              message.usage.totalTokens = message.usage.input + message.usage.output;
              emit(event);
            } else {
              if (finish || (event.finishReason !== 'stop' && event.finishReason !== 'length'))
                throw new LLMError('bad_request', '模型未正常完成文本响应');
              finish = event;
            }
          }
          if (!finish) throw new LLMError('network', '模型流未完整结束');
          if (signal?.aborted) throw new LLMError('aborted', 'Request aborted');
          message.stopReason = finish.finishReason as 'stop' | 'length';
          stream.push({ type: 'text_end', contentIndex: 0, content: (message.content[0] as { text: string }).text, partial: message });
          stream.push({ type: 'done', reason: message.stopReason, message });
        } catch (error) {
          failure = error;
          message.stopReason = 'error';
          message.errorMessage = 'Fixed-provider inference failed'; // No raw provider errors in Agent state.
          stream.push({ type: 'error', reason: 'error', error: message });
        }
      })();
      return stream;
    },
  });
  const unsubscribe = agent.subscribe(event => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta')
      emit({ type: 'delta', text: event.assistantMessageEvent.delta });
  });
  const abort = () => agent.abort();
  request.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (request.signal?.aborted) throw new LLMError('aborted', 'Request aborted');
    await agent.prompt(messages);
    if (failure) throw failure;
    if (!finish || calls !== 1) throw new LLMError('network', 'Pi inference did not complete');
    if (request.signal?.aborted) throw new LLMError('aborted', 'Request aborted');
    emit(finish);
  } finally {
    request.signal?.removeEventListener('abort', abort);
    unsubscribe();
    agent.reset(); // Private context is not retained after this task.
  }
}
