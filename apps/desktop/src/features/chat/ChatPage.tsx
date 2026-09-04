import { Plus, Trash2 } from 'lucide-react';
import { fmt, t } from '@/i18n';
import { Button, HoverAction, cn } from '@/components/ui';
import { Bubble, Composer, conversationTitle, useConversation } from '@/components/conversation';
import { sys, user } from '@/llm/prompts/base';

/**
 * 「随手问 AI」：一个不挂在任何书或故事上的临时对话页。
 *
 * 会话、流式、中止这些跟阅读器 AI 面板完全一样的逻辑放在
 * `components/conversation/useConversation`，这里只负责这个页面自己的样子。
 */
export function ChatPage() {
  const chat = useConversation({
    kind: 'scratch',
    titleFor: conversationTitle,
    buildRequest: ({ question, history }) => ({
      messages: [
        sys(t.chat.systemPrompt),
        ...history.slice(-20).map((m) => ({ role: m.role, content: m.content })),
        user(question),
      ],
      maxTokens: 4096,
    }),
  });

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-paper-300/60 bg-paper-100/60 dark:border-paper-800 dark:bg-paper-900/60">
        <div className="flex items-center justify-between px-4 pb-3 pt-5">
          <h1 className="font-serif text-base font-semibold tracking-wide text-ink-800 dark:text-paper-100">{t.nav.chat}</h1>
          <Button size="sm" variant="ghost" aria-label={t.chat.newConversation} title={t.chat.newConversation} onClick={() => void chat.startNew()}>
            <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
          </Button>
        </div>
        <ul aria-label={t.chat.conversationList} className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {chat.conversations.length === 0 && <li className="px-3 py-6 text-center text-xs leading-relaxed text-ink-400">{t.chat.noConversations}</li>}
          {chat.conversations.map((c) => {
            const on = chat.active?.id === c.id;
            return (
              <li key={c.id} className={cn('group flex items-center rounded-xl px-3 py-2 text-sm transition', on ? 'bg-paper-0 font-medium text-ink-900 shadow-soft dark:bg-paper-800 dark:text-paper-50' : 'text-ink-600 hover:bg-paper-200/60 dark:text-ink-300 dark:hover:bg-paper-800/60')}>
                <button className="flex-1 truncate rounded-lg text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-tea-500/50" aria-current={on ? 'true' : undefined} onClick={() => chat.select(c)}>{c.title}</button>
                <HoverAction label={fmt(t.a11y.deleteItem, { name: c.title })} className="p-0.5 hover:text-cinnabar-600" onClick={() => void chat.remove(c)}>
                  <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
                </HoverAction>
              </li>
            );
          })}
        </ul>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl space-y-4 px-6 py-8" role="list" aria-label={t.chat.messageList}>
            {chat.messages.length === 0 && chat.streaming === null && (
              <div className="py-24 text-center">
                <p className="font-serif text-lg text-ink-700 dark:text-paper-100">{t.chat.emptyTitle}</p>
                <p className="mt-2 text-sm leading-relaxed text-ink-400">{t.chat.emptyDesc}</p>
              </div>
            )}
            {chat.messages.map((m) => <Bubble key={m.id} role={m.role} text={m.content} />)}
            {chat.streaming !== null && <Bubble role="assistant" text={chat.streaming || t.chat.thinking} />}
            <div ref={chat.bottomRef} />
          </div>
        </div>
        <div className="px-6 pb-6 pt-2">
          <div className="mx-auto max-w-2xl">
            <Composer
              value={chat.input}
              onChange={chat.setInput}
              onSend={() => void chat.send()}
              onStop={chat.stop}
              streaming={chat.streaming}
              placeholder={t.chat.placeholder}
              hint={t.chat.sendHint}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
