import { useEffect, useMemo, useState } from 'react';
import type { Comment, NovelDetail } from '@the-water/shared';
import { fmt, t } from '@/i18n';
import { Button, Select, confirm, EmptyState, SectionTitle, Spinner } from '@/components/ui';
import { usePagedList } from '@/components/data/useAsyncData';
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
  /** 从阅读器进来时可以直接锁定到某一章（§3.6）。 */
  initialChapterIndex?: number | null;
}

/** 'all'=全部，'novel'=只看作品级，数字=只看该章。 */
type Scope = 'all' | 'novel' | number;

/** 作品下的留言区：顶层倒序，回复按需展开，可按章节筛选。 */
export function CommentSection({ novel, requireLogin, onCount, initialChapterIndex }: Props) {
  const account = useAccount((s) => s.account);
  const [scope, setScope] = useState<Scope>(initialChapterIndex ?? 'all');
  const [replies, setReplies] = useState<Record<string, Comment[]>>({});
  const [loadingReplies, setLoadingReplies] = useState<Record<string, boolean>>({});

  // 章节数上限按已发布的章节走；没有章节就不显示筛选器。
  const chapters = useMemo(
    () => Array.from({ length: Math.max(0, novel.chapterCount) }, (_, i) => i),
    [novel.chapterCount],
  );

  const { items, initializing, loadingMore, error, hasMore, reload, loadMore, setItems } = usePagedList<Comment>(
    async ({ cursor }) => {
      const client = await getBrowseClient();
      const page = await client.listComments(novel.id, {
        cursor: cursor ?? undefined,
        limit: 20,
        chapter: scope === 'all' ? undefined : scope,
      });
      return { items: page.items, nextCursor: page.nextCursor };
    },
    // 换账号会换掉「我能不能删这条」之类的判断，所以登录态也要进 key。
    { key: JSON.stringify({ novel: novel.id, scope, user: account?.userId }) },
  );

  // 换筛选 / 换账号时把展开过的回复也扔掉，否则会挂在新一批留言下面。
  useEffect(() => { setReplies({}); setLoadingReplies({}); }, [novel.id, scope, account?.userId]);

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
      const { comment } = await client.createComment(novel.id, {
        body,
        replyToId,
        // 回复跟着被回复的那条走，服务端会忽略这里传的章节。
        chapterIndex: replyToId || typeof scope !== 'number' ? undefined : scope,
      });
      if (comment.parentId) {
        setReplies((m) => ({ ...m, [comment.parentId!]: [...(m[comment.parentId!] ?? []), comment] }));
        setItems((prev) => prev.map((c) => (c.id === comment.parentId ? { ...c, replyCount: c.replyCount + 1 } : c)));
      } else {
        setItems((prev) => [comment, ...prev]);
      }
      onCount?.(novel.commentCount + 1);
      return true;
    } catch (e) {
      toast.error(friendlyError(e));
      return false;
    }
  };

  /** 就地替换一条留言（编辑、点赞都用它）。 */
  const patch = (id: string, next: (c: Comment) => Comment) => {
    setItems((prev) => prev.map((c) => (c.id === id ? next(c) : c)));
    setReplies((m) => {
      const out: Record<string, Comment[]> = {};
      for (const [k, list] of Object.entries(m)) out[k] = list.map((c) => (c.id === id ? next(c) : c));
      return out;
    });
  };

  const edit = async (comment: Comment, body: string): Promise<boolean> => {
    try {
      const client = await getClient();
      if (!client) return false;
      const res = await client.updateComment(novel.id, comment.id, { body });
      patch(comment.id, () => res.comment);
      toast.success(t.community.commentUpdated);
      return true;
    } catch (e) {
      toast.error(friendlyError(e));
      return false;
    }
  };

  const like = async (comment: Comment, liked: boolean) => {
    // 先动界面，失败再回滚：点赞是高频轻动作，等一个来回太钝。
    const before = comment;
    patch(comment.id, (c) => ({
      ...c,
      likeCount: Math.max(0, c.likeCount + (liked ? 1 : -1)),
      viewer: c.viewer ? { ...c.viewer, liked } : c.viewer,
    }));
    try {
      const client = await getClient();
      if (!client) return;
      const res = await client.likeComment(novel.id, comment.id, liked);
      patch(comment.id, (c) => ({ ...c, likeCount: res.likeCount, viewer: c.viewer ? { ...c.viewer, liked: res.liked } : c.viewer }));
    } catch (e) {
      patch(comment.id, () => before);
      toast.error(friendlyError(e));
    }
  };

  const remove = async (comment: Comment) => {
    if (!(await confirm({ title: t.community.deleteCommentConfirm, confirmText: t.common.delete, tone: 'danger' }))) return;
    try {
      const client = await getClient();
      if (!client) return;
      await client.deleteComment(novel.id, comment.id);
      if (comment.parentId) {
        setReplies((m) => ({ ...m, [comment.parentId!]: (m[comment.parentId!] ?? []).filter((r) => r.id !== comment.id) }));
        setItems((prev) => prev.map((c) => (c.id === comment.parentId ? { ...c, replyCount: Math.max(0, c.replyCount - 1) } : c)));
      } else {
        // 有回复的顶层留言留一块墓碑，回复才不会突然失去上下文。
        setItems((prev) =>
          prev.flatMap((c) => (c.id !== comment.id ? [c] : c.replyCount > 0 ? [{ ...c, status: 'deleted' as const, body: '' }] : [])),
        );
      }
      onCount?.(Math.max(0, novel.commentCount - 1));
      toast.success(t.community.commentRemoved);
    } catch (e) {
      toast.error(friendlyError(e));
    }
  };

  const scopeHint = typeof scope === 'number' ? fmt(t.community.commentScopeHint, { n: scope + 1 }) : undefined;

  return (
    <>
      <SectionTitle
        action={
          <div className="flex items-center gap-2">
            {chapters.length > 0 && (
              <Select
                aria-label={t.community.filterByChapter}
                value={String(scope)}
                onChange={(e) => {
                  const v = e.target.value;
                  setScope(v === 'all' || v === 'novel' ? v : Number(v));
                }}
                className="h-8 py-0 text-xs"
              >
                <option value="all">{t.community.allComments}</option>
                <option value="novel">{t.community.novelLevelOnly}</option>
                {chapters.map((i) => (
                  <option key={i} value={i}>{fmt(t.community.chapterNth, { n: i + 1 })}</option>
                ))}
              </Select>
            )}
            <span className="font-serif text-xs text-ink-400">{fmt(t.community.commentCountUnit, { n: novel.commentCount })}</span>
          </div>
        }
      >
        {t.community.comments}
      </SectionTitle>
      <div className="mb-6">
        {account ? (
          <>
            {scopeHint && <p className="mb-1 text-xs text-ink-400">{scopeHint}</p>}
            <CommentComposer requireLogin={requireLogin} onSubmit={(body) => post(body)} />
          </>
        ) : (
          <button
            onClick={requireLogin}
            className="w-full rounded-2xl bg-paper-0 px-4 py-3 text-left text-sm text-ink-400 shadow-soft transition hover:text-ink-600 dark:bg-paper-900"
          >
            {t.community.loginToComment}
          </button>
        )}
      </div>

      <div aria-live="polite">
        {error !== null ? (
          <div role="alert" className="flex items-center justify-between gap-3 rounded-2xl bg-cinnabar-50 px-4 py-3 text-sm text-cinnabar-700 dark:bg-cinnabar-700/20 dark:text-cinnabar-100">
            <span>{friendlyError(error)}</span>
            <Button size="sm" onClick={reload}>{t.common.retry}</Button>
          </div>
        ) : initializing ? (
          <div role="status" className="py-6 text-center text-sm text-ink-400"><Spinner className="mr-2" />{t.common.loading}</div>
        ) : items.length === 0 ? (
          <EmptyState title={scope === 'all' ? t.community.noComments : t.community.noCommentsInScope} />
        ) : (
          <ul aria-label={t.community.commentListLabel} className="space-y-3">
            {items.map((c) => (
              <CommentItem
                key={c.id}
                comment={c}
                replies={replies[c.id]}
                repliesLoading={loadingReplies[c.id]}
                onExpandReplies={() => void expandReplies(c)}
                onReply={(body, replyToId) => post(body, replyToId)}
                onDelete={remove}
                onEdit={edit}
                onLike={(comment, liked) => void like(comment, liked)}
                requireLogin={requireLogin}
              />
            ))}
          </ul>
        )}
      </div>
      {hasMore && (
        <div className="mt-6 flex justify-center">
          <Button size="sm" variant="ghost" onClick={loadMore} disabled={loadingMore}>{t.common.more}</Button>
        </div>
      )}
    </>
  );
}
