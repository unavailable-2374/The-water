import { useEffect, useRef, useState } from 'react';
import { Send, Square, Plus, Trash2 } from 'lucide-react';
import { t } from '@/i18n/zh';
import { Button, Textarea, cn } from '@/components/ui';
import { Markdown } from '@/components/Markdown';
import { toast } from '@/components/Toast';
import { appendMessage, createConversation, deleteConversation, listConversations, listMessages, renameConversation, type Conversation, type Message } from '@/db/repos/conversationsRepo';
import { providerForPurpose } from '@/llm/registry';
import { completeWithRetry } from '@/llm/complete';
import { LLMError } from '@/llm/types';

/** Scratch chat: validates provider + streaming end to end. Reused by the reader's AI panel logic later. */
export function ChatPage() {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [active, setActive] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const accRef = useRef('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const refresh = async () => setConvs(await listConversations({ kind: 'scratch' }));
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { if (active) void listMessages(active.id).then(setMessages); else setMessages([]); }, [active]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, streaming]);

  const newConv = async () => { const c = await createConversation({ kind: 'scratch' }); await refresh(); setActive(c); };
  const removeConv = async (c: Conversation) => { await deleteConversation(c.id); if (active?.id === c.id) setActive(null); await refresh(); };

  const send = async () => {
    const text = input.trim();
    if (!text || streaming !== null) return;
    let conv = active;
    if (!conv) { conv = await createConversation({ kind: 'scratch', title: text.slice(0, 20) }); setActive(conv); await refresh(); }
    else if (messages.length === 0) { await renameConversation(conv.id, text.slice(0, 20)); await refresh(); }
    setInput('');
    const userMsg = await appendMessage({ conversationId: conv.id, role: 'user', content: text });
    setMessages((m) => [...m, userMsg]);
    const history = [...messages, userMsg].slice(-20).map((m) => ({ role: m.role, content: m.content }));
    const ac = new AbortController();
    abortRef.current = ac;
    setStreaming('');
    accRef.current = '';
    try {
      const { provider, config } = await providerForPurpose('chat');
      const r = await completeWithRetry(provider, { messages: [{ role: 'system', content: '你是一个乐于助人的中文助手。' }, ...history], maxTokens: 4096, signal: ac.signal }, { onDelta: (_d, acc) => { accRef.current = acc; setStreaming(acc); } });
      const assistant = await appendMessage({ conversationId: conv.id, role: 'assistant', content: r.text, usage: r.usage, model: config.model });
      setMessages((m) => [...m, assistant]);
    } catch (e) {
      if (e instanceof LLMError && e.kind === 'aborted') {
        const partial = accRef.current;
        if (partial) { const a = await appendMessage({ conversationId: conv.id, role: 'assistant', content: partial }); setMessages((m) => [...m, a]); }
      } else toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setStreaming(null);
      abortRef.current = null;
    }
  };

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-paper-300/60 bg-paper-100/60 dark:border-paper-800 dark:bg-paper-900/60">
        <div className="flex items-center justify-between px-4 pb-3 pt-5">
          <span className="font-serif text-base font-semibold tracking-wide text-ink-800 dark:text-paper-100">{t.nav.chat}</span>
          <Button size="sm" variant="ghost" title="新对话" onClick={newConv}><Plus size={16} strokeWidth={1.75} /></Button>
        </div>
        <ul className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {convs.length === 0 && <li className="px-3 py-6 text-center text-xs leading-relaxed text-ink-400">还没有对话，想到什么就问一句</li>}
          {convs.map((c) => (
            <li key={c.id} className={cn('group flex items-center rounded-xl px-3 py-2 text-sm transition', active?.id === c.id ? 'bg-paper-0 font-medium text-ink-900 shadow-soft dark:bg-paper-800 dark:text-paper-50' : 'text-ink-600 hover:bg-paper-200/60 dark:text-ink-300 dark:hover:bg-paper-800/60')}>
              <button className="flex-1 truncate text-left" onClick={() => setActive(c)}>{c.title}</button>
              <button className="hidden rounded-full p-0.5 text-ink-400 hover:text-cinnabar-600 group-hover:block" title={t.common.delete} onClick={() => removeConv(c)}><Trash2 size={13} strokeWidth={1.75} /></button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl space-y-4 px-6 py-8">
            {messages.length === 0 && streaming === null && (
              <div className="py-24 text-center">
                <p className="font-serif text-lg text-ink-700 dark:text-paper-100">想到什么，随手问一句</p>
                <p className="mt-2 text-sm leading-relaxed text-ink-400">读书时的疑问、写作时卡住的地方，都可以在这里聊。</p>
              </div>
            )}
            {messages.map((m) => <Bubble key={m.id} role={m.role} text={m.content} />)}
            {streaming !== null && <Bubble role="assistant" text={streaming || t.chat.thinking} />}
            <div ref={bottomRef} />
          </div>
        </div>
        <div className="px-6 pb-6 pt-2">
          <div className="mx-auto flex max-w-2xl items-end gap-2 rounded-2xl bg-paper-0 p-2 shadow-soft transition focus-within:shadow-lift focus-within:ring-2 focus-within:ring-tea-500/30 dark:bg-paper-900">
            <Textarea rows={2} value={input} onChange={(e) => setInput(e.target.value)} placeholder="想问什么…"
              className="resize-none border-0! bg-transparent! px-3 py-2 shadow-none ring-0! focus:ring-0! dark:bg-transparent!"
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
            {streaming !== null ? (
              <Button variant="danger" className="mb-0.5" onClick={() => abortRef.current?.abort()}><Square size={16} strokeWidth={1.75} />{t.chat.stop}</Button>
            ) : (
              <Button variant="ai" className="mb-0.5" onClick={send}><Send size={16} strokeWidth={1.75} />{t.chat.send}</Button>
            )}
          </div>
          <p className="mx-auto mt-2 max-w-2xl text-center text-[11px] text-ink-400">Enter 发送 · Shift + Enter 换行</p>
        </div>
      </section>
    </div>
  );
}

export function Bubble({ role, text }: { role: string; text: string }) {
  const mine = role === 'user';
  return (
    <div className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
      <div className={cn('max-w-[82%] px-4 py-2.5', mine ? 'rounded-2xl rounded-tr-md bg-paper-200 text-ink-900 dark:bg-paper-800 dark:text-paper-100' : 'rounded-2xl rounded-tl-md bg-tea-50 text-ink-800 dark:bg-tea-800/40 dark:text-paper-100')}>
        {mine ? <p className="whitespace-pre-wrap text-sm leading-relaxed">{text}</p> : <Markdown text={text} />}
      </div>
    </div>
  );
}
