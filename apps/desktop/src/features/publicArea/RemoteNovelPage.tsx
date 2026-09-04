import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, BookOpen, ChevronLeft, ChevronRight, Eye, GitFork, Heart, List, MessageSquare, Share2 } from 'lucide-react';
import { LICENSE_LABELS, type ChapterContent, type ChapterMeta, type LineageNode, type LineageResponse, type NovelDetail, type NovelRef } from '@the-water/shared';
import { t } from '@/i18n/zh';
import { Badge, BookCover, Button, Card, cn, confirm, SectionTitle, Spinner } from '@/components/ui';
import { UserChip } from '@/components/UserChip';
import { FollowButton } from '@/features/community/FollowButton';
import { ShareDialog } from './ShareDialog';
import { useLoginGate } from './useLoginGate';
import { CommentSection } from '@/features/community/comments/CommentSection';
import { novelShareTarget } from '@/community/shareCard';
import { useCommunity } from '@/stores/communityStore';
import { toast } from '@/components/Toast';
import { useAccount } from '@/stores/accountStore';
import { getBrowseClient, getClient, getServerUrl } from '@/sync/account';
import { describeError, type PublicApi } from '@/sync/api';
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

export function RemoteNovelPage() {
  const { remoteId = '' } = useParams();
  const nav = useNavigate();
  const { account, loaded, refresh } = useAccount();
  const [client, setClient] = useState<PublicApi | null>(null);
  const [detail, setDetail] = useState<NovelDetail | null>(null);
  const [chapters, setChapters] = useState<ChapterMeta[]>([]);
  const [lineage, setLineage] = useState<LineageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState<number | null>(null);
  const [forking, setForking] = useState<string | null>(null);
  const [liking, setLiking] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const { requireLogin, loginDialog } = useLoginGate('喜欢、留言和二创都需要登录云端账号');
  const learn = useCommunity((s) => s.learn);

  useEffect(() => { if (!loaded) void refresh(); }, [loaded, refresh]);

  useEffect(() => {
    let cancelled = false;
    setDetail(null); setError(null); setReading(null);
    (async () => {
      try {
        const c = await getBrowseClient();
        if (cancelled) return;
        setClient(c);
        setServerUrl(await getServerUrl());
        const { novel } = await c.getNovel(remoteId);
        if (cancelled) return;
        setDetail(novel);
        if (novel.viewer) learn(novel.author.id, { following: novel.viewer.followingAuthor, blocked: novel.viewer.blockedAuthor });
        const [chapterPage, lin, view] = await Promise.all([
          novel.currentVersion ? listAllChapters(c, remoteId) : Promise.resolve([] as ChapterMeta[]),
          c.lineage(remoteId).catch(() => null),
          c.view(remoteId).catch(() => null),
        ]);
        if (cancelled) return;
        setChapters(chapterPage);
        setLineage(lin);
        if (view) setDetail((d) => (d ? { ...d, viewCount: view.viewCount } : d));
      } catch (e) {
        if (!cancelled) setError(describeError(e));
      }
    })();
    return () => { cancelled = true; };
  }, [remoteId, account?.userId, account?.serverUrl]);

  const toggleLike = async () => {
    if (!detail || !requireLogin()) return;
    setLiking(true);
    try {
      const c = await getClient();
      if (!c) return;
      const res = detail.viewer?.liked ? await c.unlike(detail.id) : await c.like(detail.id);
      setDetail({
        ...detail,
        likeCount: res.likeCount,
        viewer: {
          liked: res.liked,
          forked: detail.viewer?.forked ?? false,
          followingAuthor: detail.viewer?.followingAuthor ?? false,
          blockedAuthor: detail.viewer?.blockedAuthor ?? false,
        },
      });
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setLiking(false);
    }
  };

  const doFork = async () => {
    if (!detail || !requireLogin()) return;
    if (!detail.allowDerivatives) { toast.error('作者没有开放二创'); return; }
    if (!(await confirm({ title: `二创《${detail.title}》？`, description: `把第 v${detail.currentVersion?.versionNumber ?? '?'} 版带回你的书桌，作为二创的起点。`, confirmText: '带回书桌' }))) return;
    setForking('准备中…');
    try {
      const c = await getClient();
      if (!c) return;
      const local = await forkToLocal(c, detail.id, undefined, setForking);
      toast.success(`已带回书桌：《${local.title}》`);
      nav(`/studio/${local.id}/storyline`);
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setForking(null);
    }
  };

  if (error) {
    return (
      <div className="p-8">
        <Button size="sm" variant="ghost" onClick={() => nav('/public')}><ArrowLeft size={16} strokeWidth={1.75} />{t.common.back}</Button>
        <div className="mt-6 rounded-2xl bg-cinnabar-50 px-4 py-3 text-sm text-cinnabar-700 dark:bg-cinnabar-700/20 dark:text-cinnabar-100">{error}</div>
      </div>
    );
  }
  if (!detail || !client) return <div className="flex h-full items-center justify-center text-sm text-ink-400"><Spinner className="mr-2" />{t.common.loading}</div>;

  if (reading !== null) {
    return <ReaderView client={client} novel={detail} index={reading} chapters={chapters} onIndex={setReading} onBack={() => setReading(null)} />;
  }

  const v = detail.currentVersion;
  const liked = !!detail.viewer?.liked;
  return (
    <div className="flex h-full flex-col bg-paper-50 dark:bg-paper-950">
      <header className="flex items-center gap-3 px-5 py-3">
        <Button size="sm" variant="ghost" className="px-2" onClick={() => nav('/public')} title="回到公共书房"><ArrowLeft size={16} strokeWidth={1.75} /></Button>
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
                <span>{detail.writingStatus === 'completed' ? '已完结' : '连载中'}</span>
                <span>·</span>
                <span className="font-serif">{detail.chapterCount} 章 · {detail.charCount.toLocaleString()} 字</span>
                {v && <><span>·</span><span className="font-serif">v{v.versionNumber}{v.committedAt ? `（${new Date(v.committedAt).toLocaleDateString()}）` : ''}</span></>}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {detail.isDerivative && <Badge tone="amber">二创</Badge>}
                {detail.moderationStatus !== 'ok' && <Badge tone="red">{detail.moderationStatus === 'hidden' ? '审核中' : '已移除'}</Badge>}
                <Badge tone="neutral">{LICENSE_LABELS[detail.license]}</Badge>
                <Badge tone={detail.allowDerivatives ? 'green' : 'neutral'} dot>{detail.allowDerivatives ? '欢迎二创' : '不开放二创'}</Badge>
                {detail.tags.map((tg) => <Link key={tg} to="/public" className="rounded-full bg-paper-200/70 px-2 py-0.5 text-[11px] text-ink-500 hover:bg-tea-50 hover:text-tea-700 dark:bg-paper-800 dark:text-ink-300">#{tg}</Link>)}
              </div>
              {detail.source && (
                <div className="mt-3 text-sm text-ink-600 dark:text-ink-300">
                  改编自 <RefLink r={detail.source.novel} /> 第 v{detail.source.versionNumber} 版
                </div>
              )}
              <p className={cn('mt-5 whitespace-pre-wrap font-serif text-[15px] leading-[1.9] text-ink-700 dark:text-ink-200', !detail.summary && 'text-ink-400')}>{detail.summary || '作者还没有写简介。'}</p>
              <div className="mt-6 flex flex-wrap items-center gap-2">
                <Button variant="primary" onClick={() => setReading(0)} disabled={chapters.length === 0}><BookOpen size={16} strokeWidth={1.75} />{t.publicArea.read}</Button>
                <Button variant="ai" onClick={doFork} disabled={!detail.allowDerivatives || forking !== null} title={detail.allowDerivatives ? '带回书桌，作为二创的起点' : '作者没有开放二创'}>
                  {forking ? <Spinner className="h-3.5 w-3.5 border-paper-0/40 border-t-paper-0" /> : <GitFork size={16} strokeWidth={1.75} />}{forking ?? t.publicArea.fork}
                </Button>
                <Button variant="ghost" onClick={toggleLike} disabled={liking} title={liked ? '取消喜欢' : '喜欢'}>
                  <Heart size={16} strokeWidth={1.75} className={cn(liked && 'fill-cinnabar-500 text-cinnabar-500')} />喜欢 <span className="font-serif">{detail.likeCount}</span>
                </Button>
                <Button variant="ghost" onClick={() => setShareOpen(true)}><Share2 size={16} strokeWidth={1.75} />{t.community.share}</Button>
                <span className="ml-auto flex items-center gap-4 text-xs text-ink-400">
                  <span className="inline-flex items-center gap-1"><Eye size={14} strokeWidth={1.75} /><span className="font-serif">{detail.viewCount}</span> 次阅读</span>
                  <span className="inline-flex items-center gap-1"><GitFork size={14} strokeWidth={1.75} /><span className="font-serif">{detail.forkCount}</span> 个二创</span>
                  <span className="inline-flex items-center gap-1"><MessageSquare size={14} strokeWidth={1.75} /><span className="font-serif">{detail.commentCount}</span> 条留言</span>
                </span>
              </div>
            </div>
          </section>

          <div className="mt-10 grid gap-8 md:grid-cols-[1fr_280px]">
            <section>
              <SectionTitle action={<span className="font-serif text-xs text-ink-400">{chapters.length} 章</span>}>目录</SectionTitle>
              {chapters.length === 0 ? (
                <p className="text-sm text-ink-400">作者还没有发布章节。</p>
              ) : (
                <Card className="p-2">
                  <ol className="grid gap-0.5 sm:grid-cols-2">
                    {chapters.map((c) => (
                      <li key={c.index}>
                        <button className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition hover:bg-paper-100 dark:hover:bg-paper-800" onClick={() => setReading(c.index)}>
                          <span className="w-7 shrink-0 font-serif text-sm text-ink-400">{c.index + 1}</span>
                          <span className="flex-1 truncate font-serif text-sm tracking-wide text-ink-900 dark:text-paper-100">{c.title || `第${c.index + 1}章`}</span>
                          <span className="font-serif text-[11px] text-ink-400">{c.charCount.toLocaleString()} 字</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </Card>
              )}
            </section>

            <aside>
              <SectionTitle>家谱</SectionTitle>
              <Card>
                {lineage ? <LineageTree lineage={lineage} selfId={detail.id} /> : <div className="text-xs text-ink-400">（暂时读不到家谱）</div>}
              </Card>
            </aside>
          </div>

          <section className="mt-12">
            <CommentSection novel={detail} requireLogin={requireLogin} onCount={(n) => setDetail((d) => (d ? { ...d, commentCount: n } : d))} />
          </section>
        </div>
      </div>

      <ShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        title={t.community.shareNovel}
        target={novelShareTarget(detail, serverUrl || client.baseUrl)}
        cover={{
          title: detail.title,
          authorName: detail.author.displayName,
          handle: detail.author.handle,
          summary: detail.summary,
          stats: `${detail.chapterCount} 章 · ${detail.charCount.toLocaleString()} 字 · ${detail.writingStatus === 'completed' ? '已完结' : '连载中'}`,
          url: novelShareTarget(detail, serverUrl || client.baseUrl).url,
          badge: detail.isDerivative && detail.source ? `改编自《${detail.source.novel.title}》` : null,
        }}
      />
      {loginDialog}
    </div>
  );
}

function RefLink({ r, current }: { r: NovelRef; current?: boolean }) {
  if (r.visibility === 'unavailable') return <span className="text-ink-400">{r.title}（已下架）</span>;
  const inner: ReactNode = <>《{r.title}》<span className="text-ink-400"> {r.authorDisplayName}</span></>;
  if (current) return <span className="font-serif font-semibold text-tea-700 dark:text-tea-200">{inner}</span>;
  return <Link to={`/public/${r.id}`} className="font-serif text-ink-800 hover:text-tea-700 dark:text-paper-100 dark:hover:text-tea-200">{inner}</Link>;
}

function Connector() {
  return <span className="mr-1.5 inline-block h-3 w-3 shrink-0 self-start rounded-bl-md border-b border-l border-paper-300 dark:border-paper-800" />;
}

function LineageTree({ lineage, selfId }: { lineage: LineageResponse; selfId: string }) {
  const chain = [...lineage.ancestors, lineage.self];
  const isRoot = lineage.ancestors.length === 0;
  return (
    <div className="space-y-1 text-xs">
      {isRoot && lineage.descendants.length === 0 ? (
        <div className="text-ink-400">这是原创作品，还没有人二创。</div>
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
              <div className="mb-1.5 font-serif text-[11px] tracking-[0.2em] text-ink-400">由本作衍生</div>
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
            {n.sourceVersionNumber !== null && <span className="ml-1 font-serif text-ink-400">自 v{n.sourceVersionNumber}</span>}
          </div>
          {n.children.length > 0 && <DescendantList nodes={n.children} depth={depth + 1} selfId={selfId} />}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------

function ReaderView({ client, novel, index, chapters, onIndex, onBack }: { client: PublicApi; novel: NovelDetail; index: number; chapters: ChapterMeta[]; onIndex: (i: number) => void; onBack: () => void }) {
  const [chapter, setChapter] = useState<ChapterContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setChapter(null); setError(null);
    try {
      setChapter(await client.getChapter(novel.id, 'current', index));
    } catch (e) {
      setError(describeError(e));
    }
  }, [client, novel.id, index]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && chapter?.prev !== null && chapter?.prev !== undefined) onIndex(chapter.prev);
      if (e.key === 'ArrowRight' && chapter?.next !== null && chapter?.next !== undefined) onIndex(chapter.next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chapter, onIndex]);

  const meta = chapters[index];
  const title = chapter?.title || meta?.title || `第${index + 1}章`;
  const paragraphs = chapter ? chapter.content.split(/\n+/).map((p) => p.trim()).filter(Boolean) : [];
  const navBar = (
    <div className="flex items-center justify-between gap-2">
      <Button onClick={() => chapter?.prev !== null && chapter?.prev !== undefined && onIndex(chapter.prev)} disabled={!chapter || chapter.prev === null}><ChevronLeft size={16} strokeWidth={1.75} />上一章</Button>
      <Button variant="ghost" onClick={onBack}><List size={16} strokeWidth={1.75} />目录</Button>
      <Button onClick={() => chapter?.next !== null && chapter?.next !== undefined && onIndex(chapter.next)} disabled={!chapter || chapter.next === null}>下一章<ChevronRight size={16} strokeWidth={1.75} /></Button>
    </div>
  );

  return (
    <div className="flex h-full flex-col bg-paper-50 dark:bg-paper-950">
      <header className="flex items-center gap-3 border-b border-paper-300/60 bg-paper-100/80 px-5 py-3 backdrop-blur dark:border-paper-800 dark:bg-paper-900/80">
        <Button size="sm" variant="ghost" className="px-2" onClick={onBack} title="回到目录"><ArrowLeft size={16} strokeWidth={1.75} /></Button>
        <span className="truncate font-serif text-sm text-ink-500">{novel.title}</span>
        <span className="text-paper-400">/</span>
        <span className="truncate font-serif text-sm font-semibold tracking-wide text-ink-900 dark:text-paper-100">{title}</span>
        <span className="ml-auto font-serif text-xs text-ink-400">{index + 1} / {chapters.length}</span>
      </header>
      <div className="flex-1 overflow-y-auto">
        <article className="mx-auto max-w-3xl px-8 py-10">
          <div className="paper-texture rounded-2xl bg-paper-0 px-14 py-14 shadow-soft dark:bg-paper-900">
            <h1 className="mb-10 text-center font-serif text-2xl font-semibold tracking-wide text-ink-900 dark:text-paper-100">{title}</h1>
            {error ? (
              <div className="text-center text-sm text-cinnabar-600 dark:text-cinnabar-100">{error} <Button size="sm" variant="ghost" onClick={load}>{t.common.retry}</Button></div>
            ) : !chapter ? (
              <div className="flex justify-center py-12"><Spinner /></div>
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
