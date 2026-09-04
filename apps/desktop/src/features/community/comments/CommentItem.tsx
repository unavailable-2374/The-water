import { useState } from 'react';
import { Link } from 'react-router';
import { Heart, MessageSquare, Pencil, Trash2 } from 'lucide-react';
import type { Comment } from '@the-water/shared';
import { t, fmt } from '@/i18n';
import { Button, Spinner, cn } from '@/components/ui';
import { UserChip } from '@/components/UserChip';
import { CommentComposer } from './CommentComposer';
import { splitMentions } from './mentions';

function when(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return t.community.justNow;
  if (diff < 3_600_000) return fmt(t.community.minutesAgo, { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return fmt(t.community.hoursAgo, { n: Math.floor(diff / 3_600_000) });
  return d.toLocaleDateString();
}

/** 正文渲染：@用户名 上色并可点进主页。 */
function Body({ body }: { body: string }) {
  return (
    <>
      {splitMentions(body).map((seg, i) =>
        seg.kind === 'mention' ? (
          <Link
            key={i}
            to={`/public/u/${encodeURIComponent(seg.value.toLowerCase())}`}
            className="text-tea-700 hover:underline dark:text-tea-200"
          >
            @{seg.value}
          </Link>
        ) : (
          <span key={i}>{seg.value}</span>
        ),
      )}
    </>
  );
}

interface Props {
  comment: Comment;
  replies?: Comment[];
  repliesLoading?: boolean;
  onExpandReplies?: () => void;
  onReply?: (body: string, replyToId: string) => Promise<boolean>;
  onDelete: (comment: Comment) => void;
  onEdit?: (comment: Comment, body: string) => Promise<boolean>;
  onLike?: (comment: Comment, liked: boolean) => void;
  requireLogin: () => boolean;
  nested?: boolean;
}

/** 一条留言。已删除/被隐藏时留一块墓碑，好让下面的回复还有上下文。 */
export function CommentItem({ comment, replies, repliesLoading, onExpandReplies, onReply, onDelete, onEdit, onLike, requireLogin, nested }: Props) {
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const gone = comment.status !== 'ok';
  const liked = comment.viewer?.liked ?? false;

  return (
    <li className={cn(nested && 'pl-11')}>
      <div className="rounded-2xl bg-paper-0 p-4 shadow-soft dark:bg-paper-900">
        <div className="flex items-start justify-between gap-3">
          <UserChip user={comment.author} size="xs" showHandle={false} />
          <span className="flex shrink-0 items-center gap-2 text-[11px] text-ink-400">
            {comment.chapterIndex !== null && (
              <span className="rounded-full bg-paper-200/70 px-2 py-0.5 dark:bg-paper-800">{fmt(t.community.chapterNth, { n: comment.chapterIndex + 1 })}</span>
            )}
            {comment.editedAt && !gone && <span>{t.community.edited}</span>}
            {when(comment.createdAt)}
          </span>
        </div>
        {gone ? (
          <p className="mt-2 text-sm italic text-ink-400">{comment.status === 'deleted' ? t.community.commentDeleted : t.community.commentHidden}</p>
        ) : editing && onEdit ? (
          <div className="mt-3">
            <CommentComposer
              autoFocus
              initialBody={comment.body}
              requireLogin={requireLogin}
              submitLabel={t.common.save}
              onCancel={() => setEditing(false)}
              onSubmit={async (body) => {
                const ok = await onEdit(comment, body);
                if (ok) setEditing(false);
                return ok;
              }}
            />
          </div>
        ) : (
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-800 dark:text-paper-100">
            {comment.replyToName && <span className="mr-1 text-tea-700 dark:text-tea-200">@{comment.replyToName}</span>}
            <Body body={comment.body} />
          </p>
        )}
        {!editing && (
          <div className="mt-2 flex items-center gap-1">
            {!gone && onLike && (
              <Button
                size="sm"
                variant="ghost"
                className={cn(liked && 'text-cinnabar-600')}
                aria-pressed={liked}
                onClick={() => {
                  if (requireLogin()) onLike(comment, !liked);
                }}
              >
                <Heart size={14} strokeWidth={1.75} aria-hidden="true" fill={liked ? 'currentColor' : 'none'} />
                {comment.likeCount > 0 ? comment.likeCount : t.community.likeAction}
              </Button>
            )}
            {!gone && onReply && (
              <Button size="sm" variant="ghost" onClick={() => { if (requireLogin()) setReplying((v) => !v); }}>
                <MessageSquare size={14} strokeWidth={1.75} aria-hidden="true" />{t.community.reply}
              </Button>
            )}
            {!gone && onEdit && comment.viewer?.canEdit && (
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />{t.common.edit}
              </Button>
            )}
            {!gone && comment.viewer?.canDelete && (
              <Button size="sm" variant="ghost" className="hover:text-cinnabar-600" onClick={() => onDelete(comment)}>
                <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />{t.common.delete}
              </Button>
            )}
            {comment.replyCount > 0 && !nested && (
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={expanded}
                onClick={() => {
                  if (!expanded) onExpandReplies?.();
                  setExpanded((v) => !v);
                }}
              >
                {expanded ? t.community.collapseReplies : fmt(t.community.expandReplies, { n: comment.replyCount })}
              </Button>
            )}
          </div>
        )}
        {replying && onReply && (
          <div className="mt-3">
            <CommentComposer
              autoFocus
              requireLogin={requireLogin}
              placeholder={fmt(t.community.replyTo, { name: comment.author.displayName })}
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
        <ul aria-label={t.community.replyListLabel} className="mt-2 space-y-2">
          {repliesLoading && <li role="status" className="pl-11 text-xs text-ink-400"><Spinner className="mr-2 h-3 w-3" />{t.common.loading}</li>}
          {(replies ?? []).map((r) => (
            <CommentItem key={r.id} comment={r} onDelete={onDelete} onEdit={onEdit} onLike={onLike} requireLogin={requireLogin} nested />
          ))}
        </ul>
      )}
    </li>
  );
}
