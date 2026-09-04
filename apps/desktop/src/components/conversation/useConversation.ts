/**
 * 会话 / 流式 / 中止的共用逻辑。
 *
 * 「随手问 AI」和阅读器的 AI 讨论面板本来各写了一遍（约 60 行几乎一样的代码），
 * 差别只有三处：会话属于谁（scratch 还是某份文档）、怎么拼这次请求、
 * 用户消息要不要附带上下文。于是把这三处做成参数，其余全部收到这里。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@/i18n';
import { toast } from '@/components/Toast';
import {
  appendMessage, createConversation, deleteConversation, listConversations, listMessages, renameConversation,
  type Conversation, type ConversationKind, type Message, type MessageContext,
} from '@/db/repos/conversationsRepo';
import { providerForPurpose } from '@/llm/registry';
import { completeWithRetry } from '@/llm/complete';
import { LLMError, type ChatMessage } from '@/llm/types';

/** 一次补全请求的形状，`llm/prompts/*` 返回的 PromptSpec 正好能塞进来。 */
export interface ConversationRequest {
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
}

export interface ConversationSource {
  kind: ConversationKind;
  /** 阅读器面板绑在某份文档上；随手问 AI 不传。 */
  documentId?: string;
  /** 新会话取什么标题。 */
  titleFor: (question: string) => string;
  /** 拼这次要发给模型的消息。 */
  buildRequest: (args: { question: string; history: Message[] }) => Promise<ConversationRequest> | ConversationRequest;
  /** 用户消息要一起存下来的上下文（阅读器存所选段落与页码）。 */
  contextFor?: () => MessageContext | null;
  /** 输入框留空时用什么代替；返回 null 表示空输入不发送。 */
  emptyQuestion?: () => string | null;
  /** 一轮问答成功结束后做点收尾（阅读器用它清掉所选段落）。 */
  onAnswered?: () => void;
  /** 会话列表刷新后回调，首次进来可用来自动选中第一个。 */
  autoSelectFirst?: boolean;
}

export interface ConversationController {
  conversations: Conversation[];
  active: Conversation | null;
  messages: Message[];
  input: string;
  setInput: (v: string) => void;
  /** 正在生成时是已收到的片段（可能是空串），空闲时为 null。 */
  streaming: string | null;
  select: (conversation: Conversation | null) => void;
  startNew: () => Promise<void>;
  remove: (conversation: Conversation) => Promise<void>;
  send: () => Promise<void>;
  stop: () => void;
  /** 挂在消息列表末尾，用来自动滚到底。 */
  bottomRef: React.RefObject<HTMLDivElement | null>;
}

export function useConversation(source: ConversationSource): ConversationController {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [active, setActive] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** 中止时把已经收到的半截答案留下来，不然用户点「停止」等于白花钱。 */
  const partialRef = useRef('');
  const bottomRef = useRef<HTMLDivElement>(null);
  // source 每次渲染都是新对象，用 ref 取最新的，避免把回调塞进依赖数组。
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const activeRef = useRef<Conversation | null>(active);
  activeRef.current = active;
  const messagesRef = useRef<Message[]>(messages);
  messagesRef.current = messages;

  const { kind, documentId, autoSelectFirst = false } = source;

  const refresh = useCallback(async (): Promise<Conversation[]> => {
    const list = await listConversations(documentId === undefined ? { kind } : { kind, documentId });
    setConversations(list);
    return list;
  }, [kind, documentId]);

  useEffect(() => {
    let alive = true;
    void refresh().then((list) => {
      if (!alive) return;
      if (autoSelectFirst && activeRef.current === null && list[0]) setActive(list[0]);
    });
    return () => { alive = false; };
  }, [refresh, autoSelectFirst]);

  useEffect(() => {
    let alive = true;
    if (!active) { setMessages([]); return; }
    void listMessages(active.id).then((m) => { if (alive) setMessages(m); });
    return () => { alive = false; };
  }, [active]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, streaming]);

  // 组件卸载时把还在跑的请求掐掉，别让流继续往一个已经没人看的 state 里写。
  useEffect(() => () => abortRef.current?.abort(), []);

  const select = useCallback((conversation: Conversation | null) => setActive(conversation), []);

  const startNew = useCallback(async () => {
    const created = await createConversation(documentId === undefined ? { kind } : { kind, documentId });
    await refresh();
    setActive(created);
  }, [kind, documentId, refresh]);

  const remove = useCallback(async (conversation: Conversation) => {
    await deleteConversation(conversation.id);
    if (activeRef.current?.id === conversation.id) setActive(null);
    await refresh();
  }, [refresh]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const send = useCallback(async () => {
    const src = sourceRef.current;
    const typed = input.trim();
    const question = typed || (src.emptyQuestion?.() ?? '');
    if (question === '' || streaming !== null) return;

    let conversation = activeRef.current;
    const title = src.titleFor(typed);
    if (!conversation) {
      conversation = await createConversation(
        documentId === undefined ? { kind, title } : { kind, documentId, title },
      );
      setActive(conversation);
      await refresh();
    } else if (messagesRef.current.length === 0) {
      await renameConversation(conversation.id, title);
      await refresh();
    }
    setInput('');

    const context = src.contextFor?.() ?? null;
    const history = messagesRef.current;
    const userMsg = await appendMessage({ conversationId: conversation.id, role: 'user', content: question, context });
    setMessages((m) => [...m, userMsg]);

    const ac = new AbortController();
    abortRef.current = ac;
    setStreaming('');
    partialRef.current = '';
    try {
      const { provider, config } = await providerForPurpose('chat');
      const request = await src.buildRequest({ question, history });
      const r = await completeWithRetry(
        provider,
        { messages: request.messages, maxTokens: request.maxTokens, temperature: request.temperature, signal: ac.signal },
        { onDelta: (_d, acc) => { partialRef.current = acc; setStreaming(acc); } },
      );
      const answer = await appendMessage({ conversationId: conversation.id, role: 'assistant', content: r.text, usage: r.usage, model: config.model });
      setMessages((m) => [...m, answer]);
      src.onAnswered?.();
    } catch (e) {
      if (e instanceof LLMError && e.kind === 'aborted') {
        const partial = partialRef.current;
        if (partial) {
          const answer = await appendMessage({ conversationId: conversation.id, role: 'assistant', content: partial });
          setMessages((m) => [...m, answer]);
        }
      } else {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setStreaming(null);
      abortRef.current = null;
    }
  }, [input, streaming, kind, documentId, refresh]);

  return { conversations, active, messages, input, setInput, streaming, select, startNew, remove, send, stop, bottomRef };
}

/** 会话标题：取问题的前 20 个字，空的话给个默认名。 */
export function conversationTitle(text: string): string {
  const trimmed = text.trim();
  return trimmed === '' ? t.chat.newConversation : trimmed.slice(0, 20);
}
