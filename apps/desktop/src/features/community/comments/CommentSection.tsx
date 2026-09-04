import { useCallback, useEffect, useState } from 'react';
import type { Comment, NovelDetail } from '@the-water/shared';
import { t } from '@/i18n/zh';
import { Button, EmptyState, SectionTitle, Spinner } from '@/components/ui';
import { toast } from '@/components/Toast';
import { friendlyError } from '@/community/errors';
import { getBrowseClient, getClient } from '@/sync/account';
import { useAccount } from '@/stores/accountStore';
import { CommentComposer } from './CommentComposer';
import { CommentItem } from './CommentItem';

interface Props {
  novel: NovelDetail;
  requireLogin: () => boolean;
  onCount?: (n: number) => void;
}

/** 作品下的留言区：顶层倒序，回复按需展开。 */
export function CommentSection({ novel, requireLogin, onCount }: Props) {
  const account = useAccount((s) => s.account);
  const [items, setItems] = useState<Comment[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replies, setReplies] = useState<Record<string, Comment[]>>({});
  const [loadingReplies, setLoadingReplies] = useState<Record<string, boolean>>({});

  const load = useCallback(
    async (append: boolean, from: string | null) => {
      setBusy(true);
      setError(null);
      try {
        const client = await getBrowseClient();
        const page = await client.listComments(novel.id, { cursor: append && from ? from : undefined, limit: 20 });
        setItems((prev) => (append && prev ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch (e) {
        setError(friendlyError(e));
        if (!append) setItems([]);
      } finally {
        setBusy(false);
      }
    },
    [novel.id],
  );
  useEffect(() => { setItems(null); void load(false, null); }, [load, account?.userId]);

  const expandReplies = async (parent: Comment) => {
    if (replies[parent.id]) return;
    setLoadingReplies((m) => ({ ...m, [parent.id]: true }));
    try {
      const client = await getBrowseClient();
      const page = await client.listReplies(novel.id, parent.id, { limit: 50 });
      setReplies((m) => ({ ...m, [parent.id]: page.items }));
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setLoadingReplies((m) => ({ ...m, [parent.id]: false }));
    }
  };

  const post = async (body: string, replyToId?: string): Promise<boolean> => {
    try {
      const client = await getClient();
      if (!client) return false;
      const { comment } = await client.createComment(novel.id, { body, replyToId });
      if (comment.parentId) {
        setReplies((m) => ({ ...m, [comment.parentId!]: [...(m[comment.parentId!] ?? []), comment] }));
        setItems((prev) => prev?.map((c) => (c.id === comment.parentId ? { ...c, replyCount: c.replyCount + 1 } : c)) ?? prev);
      } else {
        setItems((prev) => [comment, ...(prev ?? [])]);
      }
      onCount?.(novel.commentCount + 1);
      return true;
    } catch (e) {
      toast.error(friendlyError(e));
      return false;
    }
  };

  const remove = async (comment: Comment) => {
    if (!confirm('删除这条留言？')) return;
    try {
      const client = await getClient();
      if (!client) return;
      await client.deleteComment(novel.id, comment.id);
      if (comment.parentId) {
        setReplies((m) => ({ ...m, [comment.parentId!]: (m[comment.parentId!] ?? []).filter((r) => r.id !== comment.id) }));
        setItems((prev) => prev?.map((c) => (c.id === comment.parentId ? { ...c, replyCount: Math.max(0, c.replyCount - 1) } : c)) ?? prev);
      } else {
        // 有回复的顶层留言留一块墓碑，回复才不会突然失去上下文。
        setItems((prev) =>
          prev
            ? prev.flatMap((c) =>
                c.id !== comment.id ? [c] : c.replyCount > 0 ? [{ ...c, status: 'deleted' as const, body: '' }] : [],
              )
            : prev,
        );
      }
      onCount?.(Math.max(0, novel.commentCount - 1));
      toast.success('已删除');
    } catch (e) {
      toast.error(friendlyError(e));
    }
  };

  return (
    <>
      <SectionTitle action={<span className="font-serif text-xs text-ink-400">{novel.commentCount} 条</span>}>{t.community.comments}</SectionTitle>
      <div className="mb-6">
        {account ? (
          <CommentComposer requireLogin={requireLogin} onSubmit={(body) => post(body)} />
        ) : (
          <button
            onClick={requireLogin}
            className="w-full rounded-2xl bg-paper-0 px-4 py-3 text-left text-sm text-ink-400 shadow-soft transition hover:text-ink-600 dark:bg-paper-900"
          >
            {t.community.loginToComment}
          </button>
        )}
      </div>

      {error ? (
        <div className="flex items-center justify-between gap-3 rounded-2xl bg-cinnabar-50 px-4 py-3 text-sm text-cinnabar-700 dark:bg-cinnabar-700/20 dark:text-cinnabar-100">
          <span>{error}</span>
          <Button size="sm" onClick={() => load(false, null)}>{t.common.retry}</Button>
        </div>
      ) : items === null ? (
        <div className="py-6 text-center text-sm text-ink-400"><Spinner className="mr-2" />{t.common.loading}</div>
      ) : items.length === 0 ? (
        <EmptyState title={t.community.noComments} />
      ) : (
        <ul className="space-y-3">
          {items.map((c) => (
            <CommentItem
              key={c.id}
              comment={c}
              replies={replies[c.id]}
              repliesLoading={loadingReplies[c.id]}
              onExpandReplies={() => void expandReplies(c)}
              onReply={(body, replyToId) => post(body, replyToId)}
              onDelete={remove}
              requireLogin={requireLogin}
            />
          ))}
        </ul>
      )}
      {cursor && (
        <div className="mt-6 flex justify-center">
          <Button size="sm" variant="ghost" onClick={() => load(true, cursor)} disabled={busy}>再看一些</Button>
        </div>
      )}
    </>
  );
}
