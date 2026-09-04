import { useState } from 'react';
import { MessageSquare, Trash2 } from 'lucide-react';
import type { Comment } from '@the-water/shared';
import { t, fmt } from '@/i18n/zh';
import { Button, Spinner, cn } from '@/components/ui';
import { UserChip } from '@/components/UserChip';
import { CommentComposer } from './CommentComposer';

function when(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return d.toLocaleDateString();
}

interface Props {
  comment: Comment;
  replies?: Comment[];
  repliesLoading?: boolean;
  onExpandReplies?: () => void;
  onReply?: (body: string, replyToId: string) => Promise<boolean>;
  onDelete: (comment: Comment) => void;
  requireLogin: () => boolean;
  nested?: boolean;
}

/** 一条留言。已删除/被隐藏时留一块墓碑，好让下面的回复还有上下文。 */
export function CommentItem({ comment, replies, repliesLoading, onExpandReplies, onReply, onDelete, requireLogin, nested }: Props) {
  const [replying, setReplying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const gone = comment.status !== 'ok';

  return (
    <li className={cn(nested && 'pl-11')}>
      <div className="rounded-2xl bg-paper-0 p-4 shadow-soft dark:bg-paper-900">
        <div className="flex items-start justify-between gap-3">
          <UserChip user={comment.author} size="xs" showHandle={false} />
          <span className="shrink-0 text-[11px] text-ink-400">{when(comment.createdAt)}</span>
        </div>
        {gone ? (
          <p className="mt-2 text-sm italic text-ink-400">{comment.status === 'deleted' ? t.community.commentDeleted : t.community.commentHidden}</p>
        ) : (
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-800 dark:text-paper-100">
            {comment.replyToName && <span className="mr-1 text-tea-700 dark:text-tea-200">@{comment.replyToName}</span>}
            {comment.body}
          </p>
        )}
        <div className="mt-2 flex items-center gap-1">
          {!gone && onReply && (
            <Button size="sm" variant="ghost" onClick={() => { if (requireLogin()) setReplying((v) => !v); }}>
              <MessageSquare size={14} strokeWidth={1.75} />{t.community.reply}
            </Button>
          )}
          {!gone && comment.viewer?.canDelete && (
            <Button size="sm" variant="ghost" className="hover:text-cinnabar-600" onClick={() => onDelete(comment)}>
              <Trash2 size={14} strokeWidth={1.75} />{t.common.delete}
            </Button>
          )}
          {comment.replyCount > 0 && !nested && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (!expanded) onExpandReplies?.();
                setExpanded((v) => !v);
              }}
            >
              {expanded ? t.community.collapseReplies : fmt(t.community.expandReplies, { n: comment.replyCount })}
            </Button>
          )}
        </div>
        {replying && onReply && (
          <div className="mt-3">
            <CommentComposer
              autoFocus
              requireLogin={requireLogin}
              placeholder={`回复 ${comment.author.displayName}`}
              submitLabel={t.community.reply}
              onCancel={() => setReplying(false)}
              onSubmit={async (body) => {
                const ok = await onReply(body, comment.id);
                if (ok) {
                  setReplying(false);
                  setExpanded(true);
                }
                return ok;
              }}
            />
          </div>
        )}
      </div>
      {expanded && (
        <ul className="mt-2 space-y-2">
          {repliesLoading && <li className="pl-11 text-xs text-ink-400"><Spinner className="mr-2 h-3 w-3" />{t.common.loading}</li>}
          {(replies ?? []).map((r) => (
            <CommentItem key={r.id} comment={r} onDelete={onDelete} requireLogin={requireLogin} nested />
          ))}
        </ul>
      )}
    </li>
  );
}
