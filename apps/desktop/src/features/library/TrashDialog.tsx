import { useCallback, useEffect, useState } from 'react';
import { FileText, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import { Button, Dialog, EmptyState } from '@/components/ui';
import { toast } from '@/components/Toast';
import { listTrashedNovels, purgeNovel, restoreNovel, type TrashedNovel } from '@/db/repos/novelsRepo';
import { TRASH_RETENTION_DAYS, listTrashedDocuments, purgeDocument, restoreDocument, trashDaysLeft, type TrashedDocument } from '@/db/maintenance';
import { useConfirm } from '@/components/ConfirmDialog';

type Entry = { kind: 'novel'; id: string; title: string; subtitle: string; deletedAt: number } | { kind: 'document'; id: string; title: string; subtitle: string; deletedAt: number };

const novelEntry = (n: TrashedNovel): Entry => ({ kind: 'novel', id: n.id, title: n.title || '未命名故事', subtitle: n.premise || n.meta.logline || '没有写下故事前提', deletedAt: n.deletedAt });
const docEntry = (d: TrashedDocument): Entry => ({ kind: 'document', id: d.id, title: d.title, subtitle: d.author ?? 'PDF 文档', deletedAt: d.deletedAt });

/** 回收站：软删的小说与文档都在这儿，可以捞回来，也可以立刻抹掉。 */
export function TrashDialog({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void | Promise<void> }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();

  const refresh = useCallback(async () => {
    const [novels, docs] = await Promise.all([listTrashedNovels(), listTrashedDocuments()]);
    setEntries([...novels.map(novelEntry), ...docs.map(docEntry)].sort((a, b) => b.deletedAt - a.deletedAt));
  }, []);
  useEffect(() => { if (open) void refresh(); }, [open, refresh]);

  const act = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      await refresh();
      await onChanged();
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const restore = (e: Entry) => act(() => (e.kind === 'novel' ? restoreNovel(e.id) : restoreDocument(e.id)), `已放回书架：${e.title}`);
  const purge = async (e: Entry) => {
    const ok = await confirm({
      title: `永久删除《${e.title}》？`,
      description: e.kind === 'novel' ? '所有章节、版本与故事线会一并抹掉，这一步不可撤销。' : '书和它的阅读进度、笔记都会一并抹掉，这一步不可撤销。',
      confirmText: '永久删除', danger: true,
    });
    if (!ok) return;
    await act(() => (e.kind === 'novel' ? purgeNovel(e.id) : purgeDocument(e.id)), `已永久删除：${e.title}`);
  };

  return (
    <>
      <Dialog open={open} onClose={onClose} title="回收站" subtitle={`删掉的东西会在这里留 ${TRASH_RETENTION_DAYS} 天，之后自动清空`} width="max-w-2xl">
        {entries.length === 0 ? (
          <EmptyState icon={<Trash2 size={36} strokeWidth={1.25} />} title="回收站是空的" description="删掉的书和故事会先放到这里，后悔了随时捞回来。" />
        ) : (
          <ul className="space-y-2">
            {entries.map((e) => {
              const left = trashDaysLeft(e.deletedAt);
              return (
                <li key={`${e.kind}:${e.id}`} className="flex items-center gap-3 rounded-xl bg-paper-0 px-4 py-3 shadow-soft dark:bg-paper-900">
                  <span className="text-ink-400">{e.kind === 'novel' ? <Sparkles size={16} strokeWidth={1.5} /> : <FileText size={16} strokeWidth={1.5} />}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-serif text-sm text-ink-900 dark:text-paper-100">{e.title}</div>
                    <div className="truncate text-xs text-ink-400">{e.subtitle}</div>
                    <div className="mt-0.5 text-[11px] text-ink-400">
                      {new Date(e.deletedAt).toLocaleString()} 删除 · {left > 0 ? `还剩 ${left} 天` : '即将清空'}
                    </div>
                  </div>
                  <Button size="sm" disabled={busy} onClick={() => restore(e)}><RotateCcw size={13} strokeWidth={1.75} />恢复</Button>
                  <Button size="sm" variant="danger" disabled={busy} onClick={() => purge(e)}><Trash2 size={13} strokeWidth={1.75} />永久删除</Button>
                </li>
              );
            })}
          </ul>
        )}
      </Dialog>
      {dialog}
    </>
  );
}
