import { useEffect, useRef, useState } from 'react';
import { Plus, Send, Square, Trash2, X } from 'lucide-react';
import { t } from '@/i18n/zh';
import { Button, Textarea } from '@/components/ui';
import { toast } from '@/components/Toast';
import type { DocumentRow } from '@/db/repos/documentsRepo';
import { getPageText } from '@/db/repos/documentsRepo';
import { appendMessage, createConversation, deleteConversation, listConversations, listMessages, renameConversation, type Conversation, type Message } from '@/db/repos/conversationsRepo';
import { providerForPurpose } from '@/llm/registry';
import { completeWithRetry } from '@/llm/complete';
import { LLMError } from '@/llm/types';
import { passageDiscussPrompt } from '@/llm/prompts/passageDiscuss';
import { useReader } from '@/stores/readerStore';
import { Bubble } from '@/features/chat/ChatPage';

export function AiDiscussPanel({ doc }: { doc: DocumentRow }) {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [active, setActive] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState<string | null>(null);
  const [passage, setPassage] = useState<{ text: string; pageNo: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pendingAsk = useReader((s) => s.pendingAsk);
  const consumeAsk = useReader((s) => s.consumeAsk);

  const refresh = async () => {
    const list = await listConversations({ documentId: doc.id, kind: 'pdf_discuss' });
    setConvs(list);
    if (!active && list[0]) setActive(list[0]);
  };
  useEffect(() => { void refresh(); }, [doc.id]);
  useEffect(() => { if (active) void listMessages(active.id).then(setMessages); else setMessages([]); }, [active]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, streaming]);
  useEffect(() => { if (pendingAsk) { setPassage(pendingAsk); consumeAsk(); } }, [pendingAsk]);

  const send = async () => {
    const question = input.trim();
    if ((!question && !passage) || streaming !== null) return;
    let conv = active;
    const title = (passage?.text ?? question).slice(0, 20);
    if (!conv) { conv = await createConversation({ kind: 'pdf_discuss', documentId: doc.id, title }); setActive(conv); await refresh(); }
    else if (messages.length === 0) { await renameConversation(conv.id, title); await refresh(); }
    setInput('');
    const q = question || '请解释这段话的含义。';
    const ctx = passage ? { selectedText: passage.text, pageNo: passage.pageNo } : null;
    const userMsg = await appendMessage({ conversationId: conv.id, role: 'user', content: q, context: ctx });
    setMessages((m) => [...m, userMsg]);
    const ac = new AbortController();
    abortRef.current = ac;
    setStreaming('');
    try {
      const { provider, config } = await providerForPurpose('chat');
      let before = '';
      let after = '';
      if (passage) {
        const pageText = (await getPageText(doc.id, passage.pageNo)) ?? '';
        const i = pageText.indexOf(passage.text);
        if (i >= 0) { before = pageText.slice(Math.max(0, i - 600), i); after = pageText.slice(i + passage.text.length, i + passage.text.length + 600); }
        else before = pageText.slice(0, 800);
      }
      const history = messages.map((m) => ({ role: m.role, content: m.role === 'user' && m.context?.selectedText ? `【所选段落】${m.context.selectedText}\n${m.content}` : m.content }));
      const spec = passageDiscussPrompt({ selectedText: passage?.text ?? '', pageNo: passage?.pageNo ?? 0, before, after, question: q, history, docTitle: doc.title });
      const r = await completeWithRetry(provider, { messages: spec.messages, maxTokens: spec.maxTokens, temperature: spec.temperature, signal: ac.signal }, { onDelta: (_d, acc) => setStreaming(acc) });
      const a = await appendMessage({ conversationId: conv.id, role: 'assistant', content: r.text, usage: r.usage, model: config.model });
      setMessages((m) => [...m, a]);
      setPassage(null);
    } catch (e) {
      if (!(e instanceof LLMError && e.kind === 'aborted')) toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setStreaming(null);
      abortRef.current = null;
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-3 pb-2 pt-3">
        <select
          className="min-w-0 flex-1 truncate rounded-xl bg-transparent px-2 py-1.5 font-serif text-sm text-ink-800 transition hover:bg-paper-200/60 focus:outline-none dark:text-paper-100 dark:hover:bg-paper-800"
          value={active?.id ?? ''}
          onChange={(e) => setActive(convs.find((c) => c.id === e.target.value) ?? null)}
        >
          {convs.length === 0 && <option value="">{t.reader.newConversation}</option>}
          {convs.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
        </select>
        <Button size="sm" variant="ghost" title={t.reader.newConversation} onClick={async () => { const c = await createConversation({ kind: 'pdf_discuss', documentId: doc.id }); await refresh(); setActive(c); }}><Plus size={16} strokeWidth={1.75} /></Button>
        {active && <Button size="sm" variant="ghost" title={t.common.delete} className="hover:text-cinnabar-600" onClick={async () => { await deleteConversation(active.id); setActive(null); await refresh(); }}><Trash2 size={16} strokeWidth={1.75} /></Button>}
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 && streaming === null && (
          <div className="flex flex-col items-center gap-1.5 py-16 text-center">
            <p className="font-serif text-sm text-ink-600 dark:text-ink-300">选一段文字，和 AI 一起读</p>
            <p className="text-xs text-ink-400">也可以直接在下面提问</p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id}>
            {m.context?.selectedText && (
              <blockquote className="mb-1.5 ml-auto line-clamp-3 max-w-[85%] border-l-2 border-tea-500/60 pl-3 font-serif text-xs leading-relaxed text-ink-500 dark:text-ink-300">
                <span className="mr-1.5 text-ink-400">第 {m.context.pageNo} 页</span>{m.context.selectedText}
              </blockquote>
            )}
            <Bubble role={m.role} text={m.content} />
          </div>
        ))}
        {streaming !== null && <Bubble role="assistant" text={streaming || t.chat.thinking} />}
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-paper-300/60 p-3 dark:border-paper-800">
        {passage && (
          <div className="mb-2 flex items-start gap-2 rounded-xl bg-paper-100 px-3 py-2 dark:bg-paper-800">
            <blockquote className="line-clamp-2 flex-1 border-l-2 border-tea-500/60 pl-2.5 font-serif text-xs leading-relaxed text-ink-600 dark:text-ink-300">
              <span className="mr-1.5 text-ink-400">第 {passage.pageNo} 页</span>{passage.text}
            </blockquote>
            <button className="rounded-full p-0.5 text-ink-400 transition hover:text-ink-800 dark:hover:text-paper-100" onClick={() => setPassage(null)} aria-label="不带这段"><X size={14} strokeWidth={1.75} /></button>
          </div>
        )}
        <div className="flex items-end gap-1.5 rounded-2xl bg-paper-0 p-1.5 shadow-soft transition focus-within:ring-2 focus-within:ring-tea-500/30 dark:bg-paper-800">
          <Textarea rows={2} value={input} onChange={(e) => setInput(e.target.value)} placeholder={passage ? '想问什么？留空就请 AI 讲讲这段话' : '想问什么…'}
            className="resize-none border-0! bg-transparent! px-2.5 py-1.5 shadow-none ring-0! focus:ring-0! dark:bg-transparent!"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
          {streaming !== null
            ? <Button size="sm" variant="danger" title={t.chat.stop} className="mb-0.5 rounded-xl" onClick={() => abortRef.current?.abort()}><Square size={14} strokeWidth={1.75} /></Button>
            : <Button size="sm" variant="ai" title={t.chat.send} className="mb-0.5 rounded-xl" onClick={send}><Send size={14} strokeWidth={1.75} /></Button>}
        </div>
      </div>
    </div>
  );
}
