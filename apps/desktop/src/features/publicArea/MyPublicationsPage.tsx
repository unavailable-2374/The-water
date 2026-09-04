/**
 * 「我的发布」（§3.2）。
 *
 * 之前作品一旦发布就只能一路向前：改不回未发布，发错版本也没法退。
 * 这一页把两件事补上 ——
 *   · 下架 / 重新上架：可逆，数据与谱系都留着，和不可逆的删除是两回事；
 *   · 版本回滚：把任何一个已提交版本设回当前版本，读者立刻看到那一版。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { EyeOff, History, RotateCcw, Upload } from 'lucide-react';
import {
  SetCurrentVersionResponseSchema,
  type NovelSummary,
  type VersionSummary,
} from '@the-water/shared';
import { fmt, t } from '@/i18n';
import { Badge, Button, Card, EmptyState, SectionTitle, Spinner, cn, confirm } from '@/components/ui';
import { useAsyncData, usePagedList } from '@/components/data/useAsyncData';
import { toast } from '@/components/Toast';
import { PublicTabs } from './PublicTabs';
import { useAccount } from '@/stores/accountStore';
import { getClient } from '@/sync/account';
import { friendlyError } from '@/community/errors';
import type { PublicApi } from '@/sync/api';

type Visibility = NovelSummary['visibility'];

/** 写成函数而不是常量表：`t` 是惰性代理，常量表会把文案固定在旧语言上。 */
function visibilityLabel(v: Visibility): string {
  if (v === 'public') return t.publicArea.visibilityPublicShort;
  if (v === 'unlisted') return t.publicArea.visibilityUnlistedShort;
  return t.publicArea.visibilityUnpublished;
}

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : t.publicArea.dateUnknown;
}

export function MyPublicationsPage() {
  const nav = useNavigate();
  const { account, loaded, refresh } = useAccount();
  const [client, setClient] = useState<PublicApi | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => { if (!loaded) void refresh(); }, [loaded, refresh]);

  const { items, initializing, loadingMore, error, hasMore, reload, loadMore, setItems } = usePagedList<NovelSummary>(
    async ({ cursor }) => {
      const c = await getClient();
      setClient(c);
      if (!c) return { items: [], nextCursor: null };
      const page = await c.myNovels({ cursor: cursor ?? undefined, limit: 20 });
      return { items: page.items, nextCursor: page.nextCursor };
    },
    { key: JSON.stringify({ user: account?.userId, server: account?.serverUrl }), enabled: !!account },
  );

  const replace = (n: NovelSummary) => setItems((prev) => prev.map((x) => (x.id === n.id ? n : x)));

  const setVisibility = async (n: NovelSummary, visibility: Visibility) => {
    if (!client) return;
    if (visibility === 'unpublished') {
      const ok = await confirm({
        title: fmt(t.publicArea.unpublishConfirmTitle, { title: n.title }),
        description: t.publicArea.unpublishConfirmDesc,
        confirmText: t.publicArea.unpublish,
      });
      if (!ok) return;
    }
    try {
      const { novel } = await client.updateNovel(n.id, { visibility });
      replace(novel);
      toast.success(visibility === 'unpublished' ? t.publicArea.unpublishedToast : fmt(t.publicArea.republishedToast, { label: visibilityLabel(visibility) }));
    } catch (e) {
      toast.error(friendlyError(e));
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-paper-50 dark:bg-paper-950">
      <div className="mx-auto max-w-4xl px-10 py-10">
        <header className="mb-6 flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-3xl font-semibold tracking-wide">{t.publicArea.tabMine}</h1>
            <p className="mt-1 text-sm text-ink-500">{t.publicArea.minePageSubtitle}</p>
          </div>
          <PublicTabs />
        </header>

        <div aria-live="polite">
          {!account ? (
            <EmptyState
              icon={<Upload size={40} strokeWidth={1.25} aria-hidden="true" />}
              title={t.publicArea.mineNeedLoginTitle}
              description={t.publicArea.mineNeedLoginDesc}
              action={<Button variant="primary" onClick={() => nav('/settings/account')}>{t.publicArea.goLogin}</Button>}
            />
          ) : error !== null ? (
            <div role="alert" className="flex items-center justify-between gap-3 rounded-2xl bg-cinnabar-50 px-4 py-3 text-sm text-cinnabar-700 dark:bg-cinnabar-700/20 dark:text-cinnabar-100">
              <span>{friendlyError(error)}</span>
              <Button size="sm" onClick={reload}>{t.common.retry}</Button>
            </div>
          ) : initializing ? (
            <div role="status" className="flex items-center justify-center py-16 text-sm text-ink-400"><Spinner className="mr-2" />{t.publicArea.mineLoading}</div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<Upload size={40} strokeWidth={1.25} aria-hidden="true" />}
              title={t.publicArea.mineEmptyTitle}
              description={t.publicArea.mineEmptyDesc}
              action={<Button variant="primary" onClick={() => nav('/library?tab=novels')}>{t.publicArea.backToDesk}</Button>}
            />
          ) : (
            <ul aria-label={t.publicArea.mineListLabel} className="space-y-3">
              {items.map((n) => (
                <li key={n.id}>
                  <NovelRow
                    novel={n}
                    client={client}
                    expanded={openId === n.id}
                    onToggle={() => setOpenId(openId === n.id ? null : n.id)}
                    onOpen={() => nav(`/public/${n.id}`)}
                    onVisibility={(v) => setVisibility(n, v)}
                    onRolledBack={replace}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        {hasMore && (
          <div className="mt-8 flex justify-center">
            <Button onClick={loadMore} disabled={loadingMore}>{loadingMore ? <Spinner className="h-3 w-3" /> : null}{t.common.more}</Button>
          </div>
        )}
      </div>
    </div>
  );
}

function NovelRow({
  novel: n,
  client,
  expanded,
  onToggle,
  onOpen,
  onVisibility,
  onRolledBack,
}: {
  novel: NovelSummary;
  client: PublicApi | null;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onVisibility: (v: Visibility) => void;
  onRolledBack: (n: NovelSummary) => void;
}) {
  const published = n.visibility !== 'unpublished';
  return (
    <Card className="p-4">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <button className="text-left font-serif text-lg font-semibold tracking-wide text-ink-900 hover:text-tea-700 dark:text-paper-100 dark:hover:text-tea-200" onClick={onOpen} aria-label={fmt(t.publicArea.openNovel, { title: n.title })}>
            {n.title}
          </button>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-400">
            <Badge tone={published ? 'green' : 'neutral'} dot>{visibilityLabel(n.visibility)}</Badge>
            {n.isDerivative && <Badge tone="amber">{t.community.derivative}</Badge>}
            <span className="font-serif">{fmt(t.publicArea.chapterCount, { n: n.chapterCount })} · {fmt(t.publicArea.charCount, { n: n.charCount.toLocaleString() })}</span>
            <span aria-hidden="true">·</span>
            <span>{fmt(t.publicArea.lastPublished, { date: formatDate(n.lastPublishedAt) })}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onToggle} aria-expanded={expanded} title={t.publicArea.versionsHint}>
            <History size={16} strokeWidth={1.75} aria-hidden="true" />{t.publicArea.versions}
          </Button>
          {published ? (
            <Button size="sm" variant="ghost" onClick={() => onVisibility('unpublished')} title={t.publicArea.unpublishHint}>
              <EyeOff size={16} strokeWidth={1.75} aria-hidden="true" />{t.publicArea.unpublish}
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => onVisibility('public')} title={t.publicArea.republishHint}>
              <Upload size={16} strokeWidth={1.75} aria-hidden="true" />{t.publicArea.republish}
            </Button>
          )}
        </div>
      </div>
      {expanded && <VersionList novel={n} client={client} onRolledBack={onRolledBack} />}
    </Card>
  );
}

/** 一本书的历史版本；只有展开时才挂载，所以取数放在这里最省。 */
interface VersionsView {
  versions: VersionSummary[];
  currentId: string | null;
}

function VersionList({
  novel: n,
  client,
  onRolledBack,
}: {
  novel: NovelSummary;
  client: PublicApi | null;
  onRolledBack: (n: NovelSummary) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const { data, error, setData } = useAsyncData<VersionsView>(
    async () => {
      if (!client) return { versions: [], currentId: null };
      const [list, detail] = await Promise.all([client.listVersions(n.id), client.getNovel(n.id)]);
      return {
        versions: list.items.filter((v) => v.status === 'committed'),
        currentId: detail.novel.currentVersion?.id ?? null,
      };
    },
    { key: JSON.stringify({ novel: n.id, server: client?.baseUrl ?? '' }), enabled: !!client },
  );

  const rollback = async (v: VersionSummary) => {
    if (!client) return;
    const ok = await confirm({
      title: fmt(t.publicArea.rollbackConfirmTitle, { version: v.versionNumber }),
      description: fmt(t.publicArea.rollbackConfirmDesc, { version: v.versionNumber, chapters: v.chapterCount, chars: v.charCount.toLocaleString() }),
      confirmText: fmt(t.publicArea.rollbackConfirmOk, { version: v.versionNumber }),
    });
    if (!ok) return;
    setBusy(v.id);
    try {
      // sync/api.ts 还没有这个方法（那个文件不归本次改动所有），先直接用底层 request。
      const res = await client.request('PUT', `/novels/${encodeURIComponent(n.id)}/current-version`, {
        body: { versionId: v.id },
        schema: SetCurrentVersionResponseSchema,
      });
      setData((prev) => ({ versions: prev?.versions ?? [], currentId: res.version.id }));
      onRolledBack(res.novel);
      toast.success(fmt(t.publicArea.rollbackDone, { version: res.version.versionNumber }));
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  if (error !== null) return <div role="alert" className="mt-4 text-xs text-cinnabar-600 dark:text-cinnabar-100">{friendlyError(error)}</div>;
  if (!data) return <div role="status" className="mt-4 flex items-center gap-2 text-xs text-ink-400"><Spinner className="h-3 w-3" />{t.publicArea.versionsLoading}</div>;
  if (data.versions.length === 0) return <div className="mt-4 text-xs text-ink-400">{t.publicArea.noCommittedVersions}</div>;

  return (
    <div className="mt-4 border-t border-paper-200 pt-3 dark:border-paper-800">
      <SectionTitle className="mb-2">{t.publicArea.versionHistory}</SectionTitle>
      <ol aria-label={t.publicArea.versionListLabel} className="space-y-1">
        {data.versions.map((v) => {
          const isCurrent = v.id === data.currentId;
          return (
            <li key={v.id} className={cn('flex items-center gap-3 rounded-xl px-3 py-2 text-sm', isCurrent && 'bg-tea-50 dark:bg-tea-800/30')}>
              <span className="w-10 shrink-0 font-serif text-ink-500">v{v.versionNumber}</span>
              <span className="font-serif text-xs text-ink-400">{fmt(t.publicArea.chapterCount, { n: v.chapterCount })} · {fmt(t.publicArea.charCount, { n: v.charCount.toLocaleString() })}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-ink-500">{v.changeNote || t.publicArea.noChangeNote}</span>
              <span className="shrink-0 font-serif text-[11px] text-ink-400">{formatDate(v.committedAt)}</span>
              {isCurrent ? (
                <Badge tone="green" dot>{t.publicArea.currentVersion}</Badge>
              ) : (
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => rollback(v)} title={fmt(t.publicArea.rollbackHint, { version: v.versionNumber })}>
                  {busy === v.id ? <Spinner className="h-3 w-3" /> : <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />}{t.publicArea.rollback}
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
