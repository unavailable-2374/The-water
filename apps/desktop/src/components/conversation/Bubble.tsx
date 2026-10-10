import { ActivityStatus, StreamingCursor } from '@/components/Activity';
import { t } from '@/i18n';
import { cn } from '@/components/ui';
import { Markdown } from '@/components/Markdown';

/**
 * 一条对话气泡。「随手问 AI」和阅读器的 AI 讨论面板共用。
 *
 * 以前它长在 `features/chat/ChatPage.tsx` 里，被阅读器反向 import——
 * 一个页面组件被另一个功能依赖，改聊天页就会牵动阅读器。现在放到公共组件层。
 *
 * 无障碍：每条消息标出说话人（`aria-label`），读屏不会把两个人的话读成一段。
 */
export function Bubble({ role, text, streaming = false }: { role: string; text: string; streaming?: boolean }) {
  const mine = role === 'user';
  return (
    <div className={cn('flex', mine ? 'justify-end' : 'justify-start')} role="listitem" aria-label={mine ? t.chat.roleUser : t.chat.roleAssistant}>
      <div className={cn('max-w-[82%] px-4 py-2.5', mine ? 'rounded-2xl rounded-tr-md bg-paper-200 text-ink-900 dark:bg-paper-800 dark:text-paper-100' : 'rounded-2xl rounded-tl-md bg-tea-50 text-ink-800 dark:bg-tea-800/40 dark:text-paper-100')}>
        {mine ? <p className="whitespace-pre-wrap text-sm leading-relaxed">{text}</p> : streaming && !text ? <ActivityStatus label={t.chat.thinking} elapsed className="text-sm text-ink-500" /> : <><Markdown text={text} />{streaming && <StreamingCursor />}</>}
      </div>
    </div>
  );
}
