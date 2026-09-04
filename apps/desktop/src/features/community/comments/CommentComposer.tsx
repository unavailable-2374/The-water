import { useState } from 'react';
import { LIMITS } from '@the-water/shared';
import { t } from '@/i18n/zh';
import { Button, Spinner, Textarea } from '@/components/ui';

interface Props {
  placeholder?: string;
  submitLabel?: string;
  autoFocus?: boolean;
  onSubmit: (body: string) => Promise<boolean>;
  onCancel?: () => void;
  requireLogin: () => boolean;
}

/** 留言输入框。提交成功（返回 true）才清空，失败时保留用户写的字。 */
export function CommentComposer({ placeholder, submitLabel, autoFocus, onSubmit, onCancel, requireLogin }: Props) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const trimmed = body.trim();

  const submit = async () => {
    if (!requireLogin() || !trimmed) return;
    setBusy(true);
    try {
      if (await onSubmit(trimmed)) setBody('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <Textarea
        rows={3}
        autoFocus={autoFocus}
        value={body}
        maxLength={LIMITS.COMMENT_BODY_MAX}
        placeholder={placeholder ?? t.community.commentPlaceholder}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
        }}
      />
      <div className="flex items-center justify-end gap-2">
        {body.length > LIMITS.COMMENT_BODY_MAX - 200 && (
          <span className="mr-auto font-serif text-[11px] text-ink-400">{body.length} / {LIMITS.COMMENT_BODY_MAX}</span>
        )}
        {onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>{t.common.cancel}</Button>}
        <Button size="sm" variant="ai" onClick={submit} disabled={busy || !trimmed}>
          {busy && <Spinner className="h-3 w-3 border-paper-0/40 border-t-paper-0" />}
          {submitLabel ?? t.community.commentSubmit}
        </Button>
      </div>
    </div>
  );
}
