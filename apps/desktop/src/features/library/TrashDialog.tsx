import { useState } from 'react';
import { FileText, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import { Button, Dialog, EmptyState, Spinner } from '@/components/ui';
import { fmt, t } from '@/i18n';
import { useAsyncData } from '@/components/data/useAsyncData';
import { toast } from '@/components/Toast';
import { listTrashedNovels, purgeNovel, restoreNovel, type TrashedNovel } from '@/db/repos/novelsRepo';
import { TRASH_RETENTION_DAYS, listTrashedDocuments, purgeDocument, restoreDocument, trashDaysLeft, type TrashedDocument } from '@/db/maintenance';
import { useConfirm } from '@/components/ConfirmDialog';

type Entry = { kind: 'novel'; id: string; title: string; subtitle: string; deletedAt: number } | { kind: 'document'; id: string; title: string; subtitle: string; deletedAt: number };

const novelEntry = (n: TrashedNovel): Entry => ({ kind: 'novel', id: n.id, title: n.title || t.common.untitledNovel, subtitle: n.premise || n.meta.logline || t.library.trash.noPremise, deletedAt: n.deletedAt });
const docEntry = (d: TrashedDocument): Entry => ({ kind: 'document', id: d.id, title: d.title, subtitle: d.author ?? t.library.trash.docKind, deletedAt: d.deletedAt });

/** 回收站：软删的小说与文档都在这儿，可以捞回来，也可以立刻抹掉。 */
export function TrashDialog({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();

  // 只有对话框开着才取数；关掉再打开会重取。
  const { data, loading, error, reload } = useAsyncData(async () => {
    const [novels, docs] = await Promise.all([listTrashedNovels(), listTrashedDocuments()]);
    return [...novels.map(novelEntry), ...docs.map(docEntry)].sort((a, b) => b.deletedAt - a.deletedAt);
  }, { key: 'library:trash', enabled: open });
  const entries = data ?? [];

  const act = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      reload();
      await onChanged();
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const restore = (e: Entry) => act(() => (e.kind === 'novel' ? restoreNovel(e.id) : restoreDocument(e.id)), fmt(t.library.trash.restored, { name: e.title }));
  const purge = async (e: Entry) => {
    const ok = await confirm({
      title: fmt(t.library.trash.purgeTitle, { name: e.title }),
      description: e.kind === 'novel' ? t.library.trash.purgeNovelDesc : t.library.trash.purgeDocDesc,
      confirmText: t.library.trash.purge, danger: true,
    });
    if (!ok) return;
    await act(() => (e.kind === 'novel' ? purgeNovel(e.id) : purgeDocument(e.id)), fmt(t.library.trash.purged, { name: e.title }));
  };

  /** 列表主体：出错 / 首屏加载 / 空 / 有内容四种形态。 */
  const renderBody = () => {
    if (error) {
      const message = error instanceof Error ? error.message : String(error);
      return (
        <div role="alert" className="rounded-2xl bg-cinnabar-50 px-4 py-3 text-sm text-cinnabar-700 dark:bg-cinnabar-700/25 dark:text-cinnabar-100">
          <p>{fmt(t.library.loadFailed, { message })}</p>
          <Button size="sm" className="mt-2" onClick={reload}>{t.common.retry}</Button>
        </div>
      );
    }
    if (loading && data === undefined) {
      return <div role="status" className="flex items-center justify-center gap-2.5 py-12 text-sm text-ink-500"><Spinner />{t.library.trash.loading}</div>;
    }
    if (entries.length === 0) {
      return <EmptyState icon={<Trash2 size={36} strokeWidth={1.25} aria-hidden="true" />} title={t.library.trash.emptyTitle} description={t.library.trash.emptyDesc} />;
    }
    return (
      <ul aria-label={t.library.trash.listLabel} className="space-y-2">
        {entries.map((e) => {
          const left = trashDaysLeft(e.deletedAt);
          return (
            <li key={`${e.kind}:${e.id}`} className="flex items-center gap-3 rounded-xl bg-paper-0 px-4 py-3 shadow-soft dark:bg-paper-900">
              <span className="text-ink-400" aria-hidden="true">{e.kind === 'novel' ? <Sparkles size={16} strokeWidth={1.5} /> : <FileText size={16} strokeWidth={1.5} />}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-serif text-sm text-ink-900 dark:text-paper-100">{e.title}</div>
                <div className="truncate text-xs text-ink-400">{e.subtitle}</div>
                <div className="mt-0.5 text-[11px] text-ink-400">
                  {fmt(t.library.trash.deletedAt, { time: new Date(e.deletedAt).toLocaleString() })} · {left > 0 ? fmt(t.library.trash.daysLeft, { days: left }) : t.library.trash.expiring}
                </div>
              </div>
              <Button size="sm" disabled={busy} aria-label={fmt(t.library.trash.restoreItem, { name: e.title })} onClick={() => restore(e)}>
                <RotateCcw size={13} strokeWidth={1.75} aria-hidden="true" />{t.library.trash.restore}
              </Button>
              <Button size="sm" variant="danger" disabled={busy} aria-label={fmt(t.library.trash.purgeItem, { name: e.title })} onClick={() => purge(e)}>
                <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />{t.library.trash.purge}
              </Button>
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <>
      <Dialog open={open} onClose={onClose} title={t.common.trash} subtitle={fmt(t.library.trash.subtitle, { days: TRASH_RETENTION_DAYS })} width="max-w-2xl">
        {renderBody()}
      </Dialog>
      {dialog}
    </>
  );
}
