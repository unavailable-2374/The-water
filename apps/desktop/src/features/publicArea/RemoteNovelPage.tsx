import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, BookOpen, ChevronLeft, ChevronRight, Eye, GitFork, Heart, List, MessageSquare, Share2 } from 'lucide-react';
import { LICENSE_LABELS, type ChapterContent, type ChapterMeta, type LineageNode, type LineageResponse, type NovelDetail, type NovelRef } from '@the-water/shared';
import { fmt, t } from '@/i18n';
import { Badge, BookCover, Button, Card, cn, confirm, IconButton, SectionTitle, Spinner } from '@/components/ui';
import { useAsyncData } from '@/components/data/useAsyncData';
import { UserChip } from '@/components/UserChip';
import { FollowButton } from '@/features/community/FollowButton';
import { ShareDialog } from './ShareDialog';
import { useLoginGate } from './useLoginGate';
import { CommentSection } from '@/features/community/comments/CommentSection';
import { novelShareTarget } from '@/community/shareCard';
import { friendlyError } from '@/community/errors';
import { useCommunity } from '@/stores/communityStore';
import { toast } from '@/components/Toast';
import { useAccount } from '@/stores/accountStore';
import { getBrowseClient, getClient, getServerUrl } from '@/sync/account';
import type { PublicApi } from '@/sync/api';
import { forkToLocal } from '@/sync/fork';

/** 目录一次最多取 200 章，长篇要接着往后翻，否则章节列表看不到底。 */
async function listAllChapters(c: PublicApi, novelId: string): Promise<ChapterMeta[]> {
  const items: ChapterMeta[] = [];
  for (;;) {
    const page = await c.listChapters(novelId, 'current', { from: items.length, limit: 200 });
    items.push(...page.items);
    if (page.items.length === 0 || items.length >= page.total) return items;
  }
}

/** 一次取齐作品页要用的东西，好让整页只有一个加载 / 出错分支。 */
interface NovelView {
  client: PublicApi;
  serverUrl: string;
  novel: NovelDetail;
  chapters: ChapterMeta[];
  lineage: LineageResponse | null;
}

export function RemoteNovelPage() {
  const { remoteId = '' } = useParams();
  const nav = useNavigate();
  const { account, loaded, refresh } = useAccount();
  const [reading, setReading] = useState<number | null>(null);
  const [forking, setForking] = useState<string | null>(null);
  const [liking, setLiking] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const { requireLogin, loginDialog } = useLoginGate(t.publicArea.loginGateNovel);
  const learn = useCommunity((s) => s.learn);

  useEffect(() => { if (!loaded) void refresh(); }, [loaded, refresh]);

  const { data, error, setData } = useAsyncData<NovelView>(
    async () => {
      const client = await getBrowseClient();
      const serverUrl = await getServerUrl();
      const { novel } = await client.getNovel(remoteId);
      if (novel.viewer) learn(novel.author.id, { following: novel.viewer.followingAuthor, blocked: novel.viewer.blockedAuthor });
      const [chapters, lineage, view] = await Promise.all([
        novel.currentVersion ? listAllChapters(client, remoteId) : Promise.resolve([] as ChapterMeta[]),
        client.lineage(remoteId).catch(() => null),
        client.view(remoteId).catch(() => null),
      ]);
      return { client, serverUrl, chapters, lineage, novel: view ? { ...novel, viewCount: view.viewCount } : novel };
    },
    { key: JSON.stringify({ remoteId, user: account?.userId, server: account?.serverUrl }) },
  );

  // 换一本书时把阅读位置归零，否则会停在上一本的章节序号上。
  useEffect(() => { setReading(null); }, [remoteId]);

  /** 就地改详情（点赞、留言数），不重新取数。只在详情已经到手时调用。 */
  const patchNovel = (next: (n: NovelDetail) => NovelDetail) =>
    setData((prev) => (prev ? { ...prev, novel: next(prev.novel) } : prev!));

  const detail = data?.novel;

  const toggleLike = async () => {
    if (!detail || !requireLogin()) return;
    setLiking(true);
    try {
      const c = await getClient();
      if (!c) return;
      const res = detail.viewer?.liked ? await c.unlike(detail.id) : await c.like(detail.id);
      patchNovel((n) => ({
        ...n,
        likeCount: res.likeCount,
        viewer: {
          liked: res.liked,
          forked: n.viewer?.forked ?? false,
          followingAuthor: n.viewer?.followingAuthor ?? false,
          blockedAuthor: n.viewer?.blockedAuthor ?? false,
        },
      }));
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setLiking(false);
    }
  };

  const doFork = async () => {
    if (!detail || !requireLogin()) return;
    if (!detail.allowDerivatives) { toast.error(t.publicArea.forkNotAllowed); return; }
    const ok = await confirm({
      title: fmt(t.publicArea.forkConfirmTitle, { title: detail.title }),
      description: fmt(t.publicArea.forkConfirmDesc, { version: detail.currentVersion?.versionNumber ?? '?' }),
      confirmText: t.publicArea.forkConfirmOk,
    });
    if (!ok) return;
    setForking(t.publicArea.preparing);
    try {
      const c = await getClient();
      if (!c) return;
      const local = await forkToLocal(c, detail.id, undefined, setForking);
      toast.success(fmt(t.publicArea.forkDone, { title: local.title }));
      nav(`/studio/${local.id}/storyline`);
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setForking(null);
    }
  };

  if (error !== null) {
    return (
      <div className="p-8">
        <Button size="sm" variant="ghost" onClick={() => nav('/public')}><ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />{t.common.back}</Button>
        <div role="alert" className="mt-6 rounded-2xl bg-cinnabar-50 px-4 py-3 text-sm text-cinnabar-700 dark:bg-cinnabar-700/20 dark:text-cinnabar-100">{friendlyError(error)}</div>
      </div>
    );
  }
  if (!data || !detail) return <div role="status" className="flex h-full items-center justify-center text-sm text-ink-400"><Spinner className="mr-2" />{t.common.loading}</div>;

  const { client, chapters, lineage, serverUrl } = data;

  if (reading !== null) {
    return <ReaderView client={client} novel={detail} index={reading} chapters={chapters} onIndex={setReading} onBack={() => setReading(null)} />;
  }

  const v = detail.currentVersion;
  const liked = !!detail.viewer?.liked;
  const shareTarget = novelShareTarget(detail, serverUrl || client.baseUrl);
  return (
    <div className="flex h-full flex-col bg-paper-50 dark:bg-paper-950">
      <header className="flex items-center gap-3 px-5 py-3">
        <IconButton label={t.publicArea.backToPublic} onClick={() => nav('/public')}><ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" /></IconButton>
        <span className="text-xs text-ink-400">{t.nav.public}</span>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-10 pb-12">
          <section className="flex gap-10">
            <BookCover title={detail.title} subtitle={detail.author.displayName} size="lg" className="mt-1" />
            <div className="min-w-0 flex-1">
              <h1 className="font-serif text-3xl font-semibold leading-tight tracking-wide">{detail.title}</h1>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <UserChip user={detail.author} size="sm" />
                {account?.userId !== detail.author.id && (
                  <FollowButton
                    userId={detail.author.id}
                    following={detail.viewer?.followingAuthor ?? false}
                    requireLogin={requireLogin}
                    hidden={detail.viewer?.blockedAuthor}
                  />
                )}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-2 text-sm text-ink-500">
                <span>{detail.writingStatus === 'completed' ? t.publicArea.statusCompleted : t.publicArea.statusOngoing}</span>
                <span aria-hidden="true">·</span>
                <span className="font-serif">{fmt(t.publicArea.chapterCount, { n: detail.chapterCount })} · {fmt(t.publicArea.charCount, { n: detail.charCount.toLocaleString() })}</span>
                {v && <><span aria-hidden="true">·</span><span className="font-serif">v{v.versionNumber}{v.committedAt ? `（${new Date(v.committedAt).toLocaleDateString()}）` : ''}</span></>}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {detail.isDerivative && <Badge tone="amber">{t.community.derivative}</Badge>}
                {detail.moderationStatus !== 'ok' && <Badge tone="red">{detail.moderationStatus === 'hidden' ? t.publicArea.moderationHidden : t.publicArea.moderationRemoved}</Badge>}
                <Badge tone="neutral">{LICENSE_LABELS[detail.license]}</Badge>
                <Badge tone={detail.allowDerivatives ? 'green' : 'neutral'} dot>{detail.allowDerivatives ? t.publicArea.welcomeDerivatives : t.publicArea.noDerivativesAllowed}</Badge>
                {detail.tags.map((tg) => <Link key={tg} to="/public" className="rounded-full bg-paper-200/70 px-2 py-0.5 text-[11px] text-ink-500 hover:bg-tea-50 hover:text-tea-700 dark:bg-paper-800 dark:text-ink-300">#{tg}</Link>)}
              </div>
              {detail.source && (
                <div className="mt-3 text-sm text-ink-600 dark:text-ink-300">
                  {t.publicArea.adaptedFrom}<RefLink r={detail.source.novel} />{fmt(t.publicArea.sourceVersion, { version: detail.source.versionNumber })}
                </div>
              )}
              <p className={cn('mt-5 whitespace-pre-wrap font-serif text-[15px] leading-[1.9] text-ink-700 dark:text-ink-200', !detail.summary && 'text-ink-400')}>{detail.summary || t.publicArea.noSummary}</p>
              <div className="mt-6 flex flex-wrap items-center gap-2">
                <Button variant="primary" onClick={() => setReading(0)} disabled={chapters.length === 0}><BookOpen size={16} strokeWidth={1.75} aria-hidden="true" />{t.publicArea.read}</Button>
                <Button variant="ai" onClick={doFork} disabled={!detail.allowDerivatives || forking !== null} title={detail.allowDerivatives ? t.publicArea.forkHint : t.publicArea.forkNotAllowed}>
                  {forking ? <Spinner className="h-3.5 w-3.5 border-paper-0/40 border-t-paper-0" /> : <GitFork size={16} strokeWidth={1.75} aria-hidden="true" />}{forking ?? t.publicArea.fork}
                </Button>
                <Button variant="ghost" onClick={toggleLike} disabled={liking} aria-pressed={liked} title={liked ? t.publicArea.unlike : t.publicArea.like}>
                  <Heart size={16} strokeWidth={1.75} aria-hidden="true" className={cn(liked && 'fill-cinnabar-500 text-cinnabar-500')} />{t.publicArea.like} <span className="font-serif">{detail.likeCount}</span>
                </Button>
                <Button variant="ghost" onClick={() => setShareOpen(true)}><Share2 size={16} strokeWidth={1.75} aria-hidden="true" />{t.community.share}</Button>
                <span className="ml-auto flex items-center gap-4 text-xs text-ink-400">
                  <span className="inline-flex items-center gap-1"><Eye size={14} strokeWidth={1.75} aria-hidden="true" /><span className="font-serif">{detail.viewCount}</span> {t.publicArea.viewsSuffix}</span>
                  <span className="inline-flex items-center gap-1"><GitFork size={14} strokeWidth={1.75} aria-hidden="true" /><span className="font-serif">{detail.forkCount}</span> {t.publicArea.forksSuffix}</span>
                  <span className="inline-flex items-center gap-1"><MessageSquare size={14} strokeWidth={1.75} aria-hidden="true" /><span className="font-serif">{detail.commentCount}</span> {t.publicArea.commentsSuffix}</span>
                </span>
              </div>
            </div>
          </section>

          <div className="mt-10 grid gap-8 md:grid-cols-[1fr_280px]">
            <section>
              <SectionTitle action={<span className="font-serif text-xs text-ink-400">{fmt(t.publicArea.chapterCount, { n: chapters.length })}</span>}>{t.publicArea.toc}</SectionTitle>
              {chapters.length === 0 ? (
                <p className="text-sm text-ink-400">{t.publicArea.tocEmpty}</p>
              ) : (
                <Card className="p-2">
                  <ol aria-label={t.publicArea.tocLabel} className="grid gap-0.5 sm:grid-cols-2">
                    {chapters.map((c) => {
                      const title = c.title || fmt(t.publicArea.chapterNumber, { n: c.index + 1 });
                      return (
                        <li key={c.index}>
                          <button className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition hover:bg-paper-100 dark:hover:bg-paper-800" onClick={() => setReading(c.index)} aria-label={fmt(t.publicArea.readChapter, { n: c.index + 1, title })}>
                            <span className="w-7 shrink-0 font-serif text-sm text-ink-400" aria-hidden="true">{c.index + 1}</span>
                            <span className="flex-1 truncate font-serif text-sm tracking-wide text-ink-900 dark:text-paper-100">{title}</span>
                            <span className="font-serif text-[11px] text-ink-400">{fmt(t.publicArea.charCount, { n: c.charCount.toLocaleString() })}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </Card>
              )}
            </section>

            <aside>
              <SectionTitle>{t.publicArea.lineage}</SectionTitle>
              <Card>
                {lineage ? <LineageTree lineage={lineage} selfId={detail.id} /> : <div className="text-xs text-ink-400">{t.publicArea.lineageUnavailable}</div>}
              </Card>
            </aside>
          </div>

          <section className="mt-12">
            <CommentSection novel={detail} requireLogin={requireLogin} onCount={(n) => patchNovel((d) => ({ ...d, commentCount: n }))} />
          </section>
        </div>
      </div>

      <ShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        title={t.community.shareNovel}
        target={shareTarget}
        cover={{
          title: detail.title,
          authorName: detail.author.displayName,
          handle: detail.author.handle,
          summary: detail.summary,
          stats: `${fmt(t.publicArea.chapterCount, { n: detail.chapterCount })} · ${fmt(t.publicArea.charCount, { n: detail.charCount.toLocaleString() })} · ${detail.writingStatus === 'completed' ? t.publicArea.statusCompleted : t.publicArea.statusOngoing}`,
          url: shareTarget.url,
          badge: detail.isDerivative && detail.source ? fmt(t.publicArea.adaptedFromTitle, { title: detail.source.novel.title }) : null,
        }}
      />
      {loginDialog}
    </div>
  );
}

function RefLink({ r, current }: { r: NovelRef; current?: boolean }) {
  if (r.visibility === 'unavailable') return <span className="text-ink-400">{fmt(t.publicArea.lineageOffline, { title: r.title })}</span>;
  const inner: ReactNode = <>《{r.title}》<span className="text-ink-400"> {r.authorDisplayName}</span></>;
  if (current) return <span className="font-serif font-semibold text-tea-700 dark:text-tea-200">{inner}</span>;
  return <Link to={`/public/${r.id}`} className="font-serif text-ink-800 hover:text-tea-700 dark:text-paper-100 dark:hover:text-tea-200">{inner}</Link>;
}

function Connector() {
  return <span aria-hidden="true" className="mr-1.5 inline-block h-3 w-3 shrink-0 self-start rounded-bl-md border-b border-l border-paper-300 dark:border-paper-800" />;
}

function LineageTree({ lineage, selfId }: { lineage: LineageResponse; selfId: string }) {
  const chain = [...lineage.ancestors, lineage.self];
  const isRoot = lineage.ancestors.length === 0;
  return (
    <div className="space-y-1 text-xs">
      {isRoot && lineage.descendants.length === 0 ? (
        <div className="text-ink-400">{t.publicArea.lineageRootEmpty}</div>
      ) : (
        <>
          <ol className="space-y-1">
            {chain.map((r, i) => (
              <li key={r.id} style={{ paddingLeft: i * 14 }} className="flex items-center">
                {i > 0 && <Connector />}
                <RefLink r={r} current={r.id === selfId} />
              </li>
            ))}
          </ol>
          {lineage.descendants.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 font-serif text-[11px] tracking-[0.2em] text-ink-400">{t.publicArea.lineageDescendants}</div>
              <DescendantList nodes={lineage.descendants} depth={0} selfId={selfId} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DescendantList({ nodes, depth, selfId }: { nodes: LineageNode[]; depth: number; selfId: string }) {
  return (
    <ul className="space-y-1">
      {nodes.map((n) => (
        <li key={n.novel.id} style={{ paddingLeft: depth * 14 }}>
          <div className="flex items-center">
            <Connector />
            <RefLink r={n.novel} current={n.novel.id === selfId} />
            {n.sourceVersionNumber !== null && <span className="ml-1 font-serif text-ink-400">{fmt(t.publicArea.fromVersion, { version: n.sourceVersionNumber })}</span>}
          </div>
          {n.children.length > 0 && <DescendantList nodes={n.children} depth={depth + 1} selfId={selfId} />}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------

function ReaderView({ client, novel, index, chapters, onIndex, onBack }: { client: PublicApi; novel: NovelDetail; index: number; chapters: ChapterMeta[]; onIndex: (i: number) => void; onBack: () => void }) {
  const { data: chapter, error, reload } = useAsyncData<ChapterContent>(
    () => client.getChapter(novel.id, 'current', index),
    { key: JSON.stringify({ novel: novel.id, index, server: client.baseUrl }) },
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && chapter?.prev !== null && chapter?.prev !== undefined) onIndex(chapter.prev);
      if (e.key === 'ArrowRight' && chapter?.next !== null && chapter?.next !== undefined) onIndex(chapter.next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chapter, onIndex]);

  const meta = chapters[index];
  const title = chapter?.title || meta?.title || fmt(t.publicArea.chapterNumber, { n: index + 1 });
  const paragraphs = chapter ? chapter.content.split(/\n+/).map((p) => p.trim()).filter(Boolean) : [];
  const navBar = (
    <div className="flex items-center justify-between gap-2" role="group" aria-label={t.publicArea.chapterNav}>
      <Button onClick={() => chapter?.prev !== null && chapter?.prev !== undefined && onIndex(chapter.prev)} disabled={!chapter || chapter.prev === null}><ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />{t.publicArea.prevChapter}</Button>
      <Button variant="ghost" onClick={onBack}><List size={16} strokeWidth={1.75} aria-hidden="true" />{t.publicArea.toc}</Button>
      <Button onClick={() => chapter?.next !== null && chapter?.next !== undefined && onIndex(chapter.next)} disabled={!chapter || chapter.next === null}>{t.publicArea.nextChapter}<ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" /></Button>
    </div>
  );

  return (
    <div className="flex h-full flex-col bg-paper-50 dark:bg-paper-950">
      <header className="flex items-center gap-3 border-b border-paper-300/60 bg-paper-100/80 px-5 py-3 backdrop-blur dark:border-paper-800 dark:bg-paper-900/80">
        <IconButton label={t.publicArea.backToToc} onClick={onBack}><ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" /></IconButton>
        <span className="truncate font-serif text-sm text-ink-500">{novel.title}</span>
        <span className="text-paper-400" aria-hidden="true">/</span>
        <span className="truncate font-serif text-sm font-semibold tracking-wide text-ink-900 dark:text-paper-100">{title}</span>
        <span className="ml-auto font-serif text-xs text-ink-400">{index + 1} / {chapters.length}</span>
      </header>
      <div className="flex-1 overflow-y-auto">
        <article className="mx-auto max-w-3xl px-8 py-10">
          <div className="paper-texture rounded-2xl bg-paper-0 px-14 py-14 shadow-soft dark:bg-paper-900">
            <h1 className="mb-10 text-center font-serif text-2xl font-semibold tracking-wide text-ink-900 dark:text-paper-100">{title}</h1>
            {error !== null ? (
              <div role="alert" className="text-center text-sm text-cinnabar-600 dark:text-cinnabar-100">{friendlyError(error)} <Button size="sm" variant="ghost" onClick={reload}>{t.common.retry}</Button></div>
            ) : !chapter ? (
              <div role="status" className="flex justify-center py-12"><Spinner /></div>
            ) : (
              <div className="prose-novel text-ink-900 dark:text-paper-100">
                {paragraphs.map((p, i) => <p key={i}>{p}</p>)}
              </div>
            )}
          </div>
          <div className="mt-8">{navBar}</div>
        </article>
      </div>
    </div>
  );
}
