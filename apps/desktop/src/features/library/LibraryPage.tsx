import { useEffect, useState } from 'react';
import { DOCUMENTS_IMPORTED_EVENT } from '@/documents/DropImport';
import { useNavigate, useSearchParams } from 'react-router';
import { Plus, Trash2, Upload, FileText, Sparkles } from 'lucide-react';
import { fmt, t } from '@/i18n';
import { Badge, BookCover, Button, EmptyState, HoverAction, Spinner, cn, deleteLabel } from '@/components/ui';
import { useAsyncData } from '@/components/data/useAsyncData';
import { toast } from '@/components/Toast';
import type { DocumentRow } from '@/db/repos/documentsRepo';
import { deleteNovel, listNovels, type Novel } from '@/db/repos/novelsRepo';
import { importPdf, pickPdfFiles } from '@/pdf/import';
import { novelCharCounts } from '@/db/repos/chaptersRepo';
import { TRASH_RETENTION_DAYS, isDocumentTrashed, listActiveDocuments, restoreDocument, softDeleteDocument } from '@/db/maintenance';
import { useConfirm } from '@/components/ConfirmDialog';
import { TrashDialog } from './TrashDialog';

type Tab = 'documents' | 'novels';

/** 小说状态标签：渲染时现取，别拷成模块顶层常量表（切语言就不跟着变了）。 */
function novelStatusLabel(status: Novel['status']): string {
  return t.novelStatus[status];
}

export function LibraryPage() {
  const [params] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'documents';
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-10 py-10">{tab === 'documents' ? <DocumentsTab /> : <NovelsTab />}</div>
    </div>
  );
}

function TrashButton({ onClick }: { onClick: () => void }) {
  return (
    <Button onClick={onClick} title={fmt(t.library.trashHint, { days: TRASH_RETENTION_DAYS })}>
      <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />{t.common.trash}
    </Button>
  );
}

function PageHeader({ title, subtitle, actions }: { title: string; subtitle: string; actions: React.ReactNode }) {
  return (
    <header className="mb-8 flex items-end justify-between gap-6">
      <div>
        <h1 className="font-serif text-3xl font-semibold tracking-wide">{title}</h1>
        <p className="mt-1 text-sm text-ink-500">{subtitle}</p>
      </div>
      <div className="flex gap-2">{actions}</div>
    </header>
  );
}

/** 首屏加载态：读屏软件靠 role="status" 知道「还在转」。 */
function LoadingBlock({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2.5 py-20 text-sm text-ink-500">
      <Spinner />{label}
    </div>
  );
}

/** 取数失败：role="alert" 会被立刻念出来。 */
function ErrorBlock({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="rounded-2xl bg-cinnabar-50 px-4 py-3 text-sm text-cinnabar-700 dark:bg-cinnabar-700/25 dark:text-cinnabar-100">
      <p>{fmt(t.library.loadFailed, { message })}</p>
      <Button size="sm" className="mt-2" onClick={onRetry}>{t.common.retry}</Button>
    </div>
  );
}

function DocumentsTab() {
  const [trashOpen, setTrashOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const { confirm, dialog } = useConfirm();
  const { data, loading, error, reload } = useAsyncData(() => listActiveDocuments(), { key: 'library:documents' });
  const docs = data ?? [];

  // 拖拽导入发生在书架之外（窗口级），靠事件回来刷新列表。
  useEffect(() => {
    const onImported = () => reload();
    window.addEventListener(DOCUMENTS_IMPORTED_EVENT, onImported);
    return () => window.removeEventListener(DOCUMENTS_IMPORTED_EVENT, onImported);
  }, [reload]);

  const doImport = async () => {
    const files = await pickPdfFiles();
    if (files.length === 0) return;
    setBusy(true);
    try {
      for (const f of files) {
        const r = await importPdf(f);
        if (r.status === 'duplicate') {
          // 同一份 PDF 之前被丢进回收站的话，重新导入就等于把它捞回来
          if (await isDocumentTrashed(r.doc.id)) { await restoreDocument(r.doc.id); toast.success(fmt(t.library.restoredFromTrash, { name: r.doc.title })); }
          else toast.info(fmt(t.library.duplicateOf, { name: r.doc.title }));
        } else if (r.status === 'error') toast.error(fmt(t.library.importFail, { message: r.error }));
        else if (r.status === 'unsupported') toast.error(r.message);
        else toast.success(fmt(t.library.importOk, { name: r.doc.title }));
      }
      reload();
    } finally { setBusy(false); }
  };
  const removeDoc = async (d: DocumentRow) => {
    const ok = await confirm({
      title: fmt(t.library.trashDocTitle, { name: d.title }),
      description: fmt(t.library.trashDocDesc, { days: TRASH_RETENTION_DAYS }),
      confirmText: t.library.toTrash, danger: true,
    });
    if (!ok) return;
    // 软删：文件先留着，等回收站到期或永久删除时再连文件一起清掉
    await softDeleteDocument(d.id);
    toast.success(fmt(t.library.trashedOk, { name: d.title }));
    reload();
  };

  return (
    <>
      <PageHeader
        title={t.library.docsTitle}
        subtitle={docs.length ? fmt(t.library.docsSubtitle, { count: docs.length }) : t.library.docsSubtitleEmpty}
        actions={<>
          <TrashButton onClick={() => setTrashOpen(true)} />
          <Button variant="primary" onClick={doImport} disabled={busy}>
            <Upload size={16} strokeWidth={1.75} aria-hidden="true" />{busy ? t.library.importing : t.library.importDoc}
          </Button>
        </>}
      />
      {error ? <ErrorBlock error={error} onRetry={reload} />
        : loading && data === undefined ? <LoadingBlock label={t.library.loadingDocs} />
        : docs.length === 0 ? (
          <EmptyState
            icon={<FileText size={40} strokeWidth={1.25} aria-hidden="true" />}
            title={t.library.docsEmptyTitle}
            description={t.library.docsEmptyDesc}
            action={<Button variant="primary" onClick={doImport}>{t.library.importFirst}</Button>}
          />
        ) : (
          <ul aria-label={t.library.docsListLabel} className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-8 gap-y-10">
            {docs.map((d) => {
              const pct = d.pageCount ? Math.round(((d.lastPage - 1) / d.pageCount) * 100) : 0;
              return (
                <li key={d.id} className="group relative">
                  <button
                    className="block w-full text-left"
                    aria-label={d.lastOpenedAt ? fmt(t.library.docCardReading, { name: d.title, pct }) : fmt(t.library.docCardNotStarted, { name: d.title })}
                    onClick={() => nav(`/reader/${d.id}`)}
                  >
                    <BookCover title={d.title} subtitle={d.author ?? undefined} size="md" className="mx-auto transition-transform duration-200 group-hover:-translate-y-1" />
                    <div className="mt-3 line-clamp-2 text-center font-serif text-sm leading-snug text-ink-800 dark:text-paper-100">{d.title}</div>
                    <div className="mt-1 text-center text-[11px] text-ink-400">
                      {d.lastOpenedAt
                        ? `${fmt(t.library.readPct, { pct })} · ${fmt(t.library.lastRead, { page: d.lastPage })}`
                        : fmt(t.library.notStarted, { pages: d.pageCount })}
                    </div>
                  </button>
                  <HoverAction
                    label={deleteLabel(d.title)}
                    className="absolute -right-1 -top-1 bg-paper-0 shadow-soft hover:text-cinnabar-600 dark:bg-paper-800"
                    onClick={() => removeDoc(d)}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </HoverAction>
                </li>
              );
            })}
          </ul>
        )}
      <TrashDialog open={trashOpen} onClose={() => setTrashOpen(false)} onChanged={reload} />
      {dialog}
    </>
  );
}

function NovelsTab() {
  const [trashOpen, setTrashOpen] = useState(false);
  const nav = useNavigate();
  const { confirm, dialog } = useConfirm();
  // 字数一次聚合查询拿全，别每本书查一次
  const { data, loading, error, reload } = useAsyncData(async () => {
    const [list, counts] = await Promise.all([listNovels(), novelCharCounts()]);
    return list.map((n) => ({ ...n, chars: counts[n.id] ?? 0 }));
  }, { key: 'library:novels' });
  const novels = data ?? [];

  const removeNovel = async (n: Novel) => {
    const name = n.title || t.common.untitledNovel;
    const ok = await confirm({
      title: fmt(t.library.trashNovelTitle, { name }),
      description: fmt(t.library.trashNovelDesc, { days: TRASH_RETENTION_DAYS }),
      confirmText: t.library.toTrash, danger: true,
    });
    if (!ok) return;
    await deleteNovel(n.id);
    toast.success(fmt(t.library.trashedOk, { name }));
    reload();
  };

  return (
    <>
      <PageHeader
        title={t.library.novelsTitle}
        subtitle={novels.length ? fmt(t.library.novelsSubtitle, { count: novels.length }) : t.library.novelsSubtitleEmpty}
        actions={<>
          <TrashButton onClick={() => setTrashOpen(true)} />
          <Button onClick={() => nav('/studio/import')}><Upload size={16} strokeWidth={1.75} aria-hidden="true" />{t.library.importText}</Button>
          <Button variant="primary" onClick={() => nav('/studio/new')}><Plus size={16} strokeWidth={1.75} aria-hidden="true" />{t.library.newStory}</Button>
        </>}
      />
      {error ? <ErrorBlock error={error} onRetry={reload} />
        : loading && data === undefined ? <LoadingBlock label={t.library.loadingNovels} />
        : novels.length === 0 ? (
          <EmptyState
            icon={<Sparkles size={40} strokeWidth={1.25} aria-hidden="true" />}
            title={t.library.novelsEmptyTitle}
            description={t.library.novelsEmptyDesc}
            action={<Button variant="primary" onClick={() => nav('/studio/new')}>{t.library.newStory}</Button>}
          />
        ) : (
          <ul aria-label={t.library.novelsListLabel} className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-5">
            {novels.map((n) => {
              const pct = n.targetChars ? Math.min(100, Math.round((n.chars / n.targetChars) * 100)) : 0;
              const name = n.title || t.common.untitledNovel;
              return (
                <li key={n.id} className="group relative flex gap-4 rounded-2xl bg-paper-0 p-4 shadow-soft transition hover:shadow-lift dark:bg-paper-900">
                  <button
                    className="flex flex-1 gap-4 text-left"
                    aria-label={fmt(t.library.novelCard, { name, status: novelStatusLabel(n.status), pct })}
                    onClick={() => nav(`/studio/${n.id}`)}
                  >
                    <BookCover title={n.title} size="sm" />
                    <div className="min-w-0 flex-1 py-0.5">
                      <div className="line-clamp-1 font-serif text-base font-semibold">{name}</div>
                      <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-500">{n.premise || n.meta.logline || t.library.noPremise}</div>
                      <div className="mt-3 flex items-center gap-2 text-[11px] text-ink-500">
                        <Badge tone={n.status === 'complete' ? 'green' : n.status === 'generating' ? 'ai' : 'neutral'} dot>{novelStatusLabel(n.status)}</Badge>
                        {n.origin && <Badge tone="amber">{t.library.derived}</Badge>}
                        {n.remote?.currentVersionId && <Badge tone="blue">{t.library.published}</Badge>}
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <div
                          role="progressbar"
                          aria-label={t.library.writeProgress}
                          aria-valuenow={pct}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          className="h-1 flex-1 rounded-full bg-paper-200 dark:bg-paper-800"
                        >
                          <div className={cn('h-1 rounded-full', n.status === 'complete' ? 'bg-tea-500' : 'bg-cinnabar-500/70')} style={{ width: `${pct}%` }} />
                        </div>
                        <span className="font-serif text-[11px] text-ink-500">
                          {fmt(t.library.charsProgress, { chars: n.chars.toLocaleString(), target: n.targetChars.toLocaleString() })}
                        </span>
                      </div>
                    </div>
                  </button>
                  <HoverAction
                    label={deleteLabel(name)}
                    className="absolute right-3 top-3 hover:bg-paper-100 hover:text-cinnabar-600 dark:hover:bg-paper-800"
                    onClick={() => removeNovel(n)}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </HoverAction>
                </li>
              );
            })}
          </ul>
        )}
      <TrashDialog open={trashOpen} onClose={() => setTrashOpen(false)} onChanged={reload} />
      {dialog}
    </>
  );
}
