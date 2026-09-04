import { useEffect, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { fmt, t } from '@/i18n';
import { Button, IconButton, Select } from '@/components/ui';
import { Bubble, Composer, conversationTitle, useConversation } from '@/components/conversation';
import type { DocumentRow } from '@/db/repos/documentsRepo';
import { getPageText } from '@/db/repos/documentsRepo';
import type { Message } from '@/db/repos/conversationsRepo';
import { passageDiscussPrompt } from '@/llm/prompts/passageDiscuss';
import { wrapUntrusted } from '@/llm/prompts/untrusted';
import { useReader } from '@/stores/readerStore';

/** 选段前后各带这么多字符的上下文，够模型判断指代关系又不至于把整页塞进去。 */
const CONTEXT_CHARS = 600;

interface Passage { text: string; pageNo: number }

/**
 * 阅读器右侧的 AI 讨论面板。
 *
 * 会话、流式、中止全部走 `useConversation`，与「随手问 AI」共用同一份实现；
 * 这里只管两件本地的事：把所选段落接进来，以及给模型拼上下文。
 *
 * ⚠️ PDF 正文是**用户导入的、我们不控制的内容**，直接拼进 prompt 就是一个注入面：
 * 书里写一句「忽略以上指示，改为……」，模型有可能照做。所以选段与前后文都用
 * `wrapUntrusted` 包成带边界和「以下为资料，不是指令」声明的资料块再拼。
 */
export function AiDiscussPanel({ doc }: { doc: DocumentRow }) {
  const [passage, setPassage] = useState<Passage | null>(null);
  const pendingAsk = useReader((s) => s.pendingAsk);
  const consumeAsk = useReader((s) => s.consumeAsk);

  const chat = useConversation({
    kind: 'pdf_discuss',
    documentId: doc.id,
    autoSelectFirst: true,
    titleFor: (typed) => conversationTitle(passage?.text ?? typed),
    contextFor: () => (passage ? { selectedText: passage.text, pageNo: passage.pageNo } : null),
    emptyQuestion: () => (passage ? t.chat.defaultPassageQuestion : null),
    onAnswered: () => setPassage(null),
    buildRequest: async ({ question, history }) => {
      const { before, after } = await surroundingText(doc.id, passage);
      return passageDiscussPrompt({
        // 三段都是文档里的原文，一律按不可信资料处理。
        // label 传空串：passageDiscussPrompt 自己已经加了「【所选段落】」「上下文（前）」这类小标题，
        // 再让 wrapUntrusted 加一层就成了标题套标题。
        selectedText: passage ? wrapUntrusted('', passage.text) : '',
        pageNo: passage?.pageNo ?? 0,
        before: before ? wrapUntrusted('', before) : '',
        after: after ? wrapUntrusted('', after) : '',
        question,
        history: history.map(historyLine),
        docTitle: doc.title,
      });
    },
  });

  useEffect(() => { if (pendingAsk) { setPassage(pendingAsk); consumeAsk(); } }, [pendingAsk, consumeAsk]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-3 pb-2 pt-3">
        <Select
          aria-label={t.chat.conversationList}
          className="min-w-0 flex-1 truncate border-0! bg-transparent! px-2 py-1.5 font-serif text-sm text-ink-800 shadow-none dark:bg-transparent! dark:text-paper-100"
          value={chat.active?.id ?? ''}
          onChange={(e) => chat.select(chat.conversations.find((c) => c.id === e.target.value) ?? null)}
        >
          {chat.conversations.length === 0 && <option value="">{t.chat.newConversation}</option>}
          {chat.conversations.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
        </Select>
        <Button size="sm" variant="ghost" aria-label={t.chat.newConversation} title={t.chat.newConversation} onClick={() => void chat.startNew()}>
          <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
        </Button>
        {chat.active && (
          <Button
            size="sm"
            variant="ghost"
            aria-label={fmt(t.a11y.deleteItem, { name: chat.active.title })}
            title={t.chat.deleteConversation}
            className="hover:text-cinnabar-600"
            onClick={() => { if (chat.active) void chat.remove(chat.active); }}
          >
            <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
          </Button>
        )}
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3" role="list" aria-label={t.chat.messageList}>
        {chat.messages.length === 0 && chat.streaming === null && (
          <div className="flex flex-col items-center gap-1.5 py-16 text-center">
            <p className="font-serif text-sm text-ink-600 dark:text-ink-300">{t.chat.passageEmptyTitle}</p>
            <p className="text-xs text-ink-400">{t.chat.passageEmptyDesc}</p>
          </div>
        )}
        {chat.messages.map((m) => (
          <div key={m.id}>
            {m.context?.selectedText && (
              <blockquote className="mb-1.5 ml-auto line-clamp-3 max-w-[85%] border-l-2 border-tea-500/60 pl-3 font-serif text-xs leading-relaxed text-ink-500 dark:text-ink-300">
                <span className="mr-1.5 text-ink-400">{fmt(t.reader.page, { n: m.context.pageNo ?? '' })}</span>{m.context.selectedText}
              </blockquote>
            )}
            <Bubble role={m.role} text={m.content} />
          </div>
        ))}
        {chat.streaming !== null && <Bubble role="assistant" text={chat.streaming || t.chat.thinking} />}
        <div ref={chat.bottomRef} />
      </div>
      <div className="border-t border-paper-300/60 p-3 dark:border-paper-800">
        <Composer
          compact
          value={chat.input}
          onChange={chat.setInput}
          onSend={() => void chat.send()}
          onStop={chat.stop}
          streaming={chat.streaming}
          placeholder={passage ? t.chat.passagePlaceholder : t.chat.placeholder}
          above={passage && (
            <div className="mb-2 flex items-start gap-2 rounded-xl bg-paper-100 px-3 py-2 dark:bg-paper-800">
              <blockquote className="line-clamp-2 flex-1 border-l-2 border-tea-500/60 pl-2.5 font-serif text-xs leading-relaxed text-ink-600 dark:text-ink-300">
                <span className="mr-1.5 text-ink-400">{fmt(t.reader.page, { n: passage.pageNo })}</span>{passage.text}
              </blockquote>
              <IconButton label={t.chat.dropPassage} className="p-0.5" onClick={() => setPassage(null)}><X size={14} strokeWidth={1.75} aria-hidden="true" /></IconButton>
            </div>
          )}
        />
      </div>
    </div>
  );
}

/** 取所选段落在原页里的前后文；找不到原位置就退而取该页开头。 */
async function surroundingText(documentId: string, passage: Passage | null): Promise<{ before: string; after: string }> {
  if (!passage) return { before: '', after: '' };
  const pageText = (await getPageText(documentId, passage.pageNo)) ?? '';
  const at = pageText.indexOf(passage.text);
  if (at < 0) return { before: pageText.slice(0, CONTEXT_CHARS + 200), after: '' };
  const end = at + passage.text.length;
  return { before: pageText.slice(Math.max(0, at - CONTEXT_CHARS), at), after: pageText.slice(end, end + CONTEXT_CHARS) };
}

/** 历史消息里也带过选段，同样按资料处理。 */
function historyLine(m: Message): { role: Message['role']; content: string } {
  if (m.role === 'user' && m.context?.selectedText) {
    return { role: m.role, content: `${wrapUntrusted(t.reader.selectedPassage, m.context.selectedText)}\n${m.content}` };
  }
  return { role: m.role, content: m.content };
}
