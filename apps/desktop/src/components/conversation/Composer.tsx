import type { ReactNode } from 'react';
import { Send, Square } from 'lucide-react';
import { t } from '@/i18n';
import { Button, Textarea, cn } from '@/components/ui';

/**
 * 提问输入框 + 发送 / 停止按钮。两个 AI 面板共用，只有尺寸和上方挂件不同。
 *
 * 无障碍：文本框有 `aria-label`；发送与停止是同一个位置上的两个按钮，
 * 各自带文字说明，读屏能分清「正在生成、可以停」和「可以发」。
 */
export function Composer({ value, onChange, onSend, onStop, streaming, placeholder, above, hint, compact }: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** 非 null 表示正在生成。 */
  streaming: string | null;
  placeholder: string;
  /** 输入框上方的挂件，例如阅读器的「所选段落」小卡片。 */
  above?: ReactNode;
  hint?: string;
  compact?: boolean;
}) {
  const generating = streaming !== null;
  return (
    <div>
      {above}
      <div className={cn(
        'flex items-end gap-1.5 rounded-2xl bg-paper-0 shadow-soft transition focus-within:ring-2 focus-within:ring-tea-500/30',
        compact ? 'p-1.5 dark:bg-paper-800' : 'gap-2 p-2 focus-within:shadow-lift dark:bg-paper-900',
      )}>
        <Textarea
          rows={2}
          value={value}
          aria-label={t.chat.placeholderHint}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={cn('resize-none border-0! bg-transparent! shadow-none ring-0! focus:ring-0! dark:bg-transparent!', compact ? 'px-2.5 py-1.5' : 'px-3 py-2')}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } }}
        />
        {generating ? (
          <Button size={compact ? 'sm' : 'md'} variant="danger" aria-label={t.chat.stop} title={t.chat.stop} className={cn('mb-0.5', compact && 'rounded-xl')} onClick={onStop}>
            <Square size={compact ? 14 : 16} strokeWidth={1.75} aria-hidden="true" />{!compact && t.chat.stop}
          </Button>
        ) : (
          <Button size={compact ? 'sm' : 'md'} variant="ai" aria-label={t.chat.send} title={t.chat.send} className={cn('mb-0.5', compact && 'rounded-xl')} onClick={onSend}>
            <Send size={compact ? 14 : 16} strokeWidth={1.75} aria-hidden="true" />{!compact && t.chat.send}
          </Button>
        )}
      </div>
      {hint && <p className="mt-2 text-center text-[11px] text-ink-400">{hint}</p>}
    </div>
  );
}
