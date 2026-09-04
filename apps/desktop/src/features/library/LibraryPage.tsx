import { useEffect, useState } from 'react';
import { DOCUMENTS_IMPORTED_EVENT } from '@/documents/DropImport';
import { useNavigate, useSearchParams } from 'react-router';
import { Plus, Trash2, Upload, FileText, Sparkles } from 'lucide-react';
import { fmt, t } from '@/i18n/zh';
import { Badge, BookCover, Button, EmptyState, cn } from '@/components/ui';
import { toast } from '@/components/Toast';
import type { DocumentRow } from '@/db/repos/documentsRepo';
import { deleteNovel, listNovels, type Novel } from '@/db/repos/novelsRepo';
import { importPdf, pickPdfFiles } from '@/pdf/import';
import { novelCharCounts } from '@/db/repos/chaptersRepo';
import { TRASH_RETENTION_DAYS, isDocumentTrashed, listActiveDocuments, restoreDocument, softDeleteDocument } from '@/db/maintenance';
import { useConfirm } from '@/components/ConfirmDialog';
import { TrashDialog } from './TrashDialog';

type Tab = 'documents' | 'novels';

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
  return <Button onClick={onClick} title={`删掉的书和故事会在回收站留 ${TRASH_RETENTION_DAYS} 天`}><Trash2 size={16} strokeWidth={1.75} />回收站</Button>;
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

function DocumentsTab() {
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const nav = useNavigate();
  const { confirm, dialog } = useConfirm();
  const refresh = async () => setDocs(await listActiveDocuments());
  useEffect(() => { void refresh(); }, []);
  // 拖拽导入发生在书架之外（窗口级），靠事件回来刷新列表。
  useEffect(() => {
    const onImported = () => void refresh();
    window.addEventListener(DOCUMENTS_IMPORTED_EVENT, onImported);
    return () => window.removeEventListener(DOCUMENTS_IMPORTED_EVENT, onImported);
  }, []);

  const doImport = async () => {
    const files = await pickPdfFiles();
    if (files.length === 0) return;
    setBusy(true);
    try {
      for (const f of files) {
        const r = await importPdf(f);
        if (r.status === 'duplicate') {
          // 同一份 PDF 之前被丢进回收站的话，重新导入就等于把它捞回来
          if (await isDocumentTrashed(r.doc.id)) { await restoreDocument(r.doc.id); toast.success(`已从回收站放回书架：${r.doc.title}`); }
          else toast.info(`${t.library.duplicate}：${r.doc.title}`);
        } else if (r.status === 'error') toast.error(`导入失败：${r.error}`);
        else if (r.status === 'unsupported') toast.error(r.message);
        else toast.success(`已放上书架：${r.doc.title}`);
      }
      await refresh();
    } finally { setBusy(false); }
  };
  const removeDoc = async (d: DocumentRow) => {
    const ok = await confirm({ title: `把《${d.title}》移到回收站？`, description: `${TRASH_RETENTION_DAYS} 天内都可以在回收站里恢复，笔记和阅读进度都还在。`, confirmText: '移到回收站', danger: true });
    if (!ok) return;
    // 软删：文件先留着，等回收站到期或永久删除时再连文件一起清掉
    await softDeleteDocument(d.id);
    toast.success(`已移到回收站：${d.title}`);
    await refresh();
  };

  return (
    <>
      <PageHeader title="书架" subtitle={docs.length ? `${docs.length} 本书，随时接着读` : '把想读的 PDF、TXT、Markdown 放上来，或直接拖进窗口'}
        actions={<><TrashButton onClick={() => setTrashOpen(true)} /><Button variant="primary" onClick={doImport} disabled={busy}><Upload size={16} strokeWidth={1.75} />{busy ? t.library.importing : '导入文档'}</Button></>} />
      {docs.length === 0 ? (
        <EmptyState icon={<FileText size={40} strokeWidth={1.25} />} title="书架还空着" description="导入一本 PDF / TXT / Markdown 开始阅读，也可以直接把文件拖进窗口。选中任何一段文字，就可以请 AI 一起讨论。" action={<Button variant="primary" onClick={doImport}>导入第一本书</Button>} />
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-8 gap-y-10">
          {docs.map((d) => {
            const pct = d.pageCount ? Math.round(((d.lastPage - 1) / d.pageCount) * 100) : 0;
            return (
              <li key={d.id} className="group relative">
                <button className="block w-full text-left" onClick={() => nav(`/reader/${d.id}`)}>
                  <BookCover title={d.title} subtitle={d.author ?? undefined} size="md" className="mx-auto transition-transform duration-200 group-hover:-translate-y-1" />
                  <div className="mt-3 line-clamp-2 text-center font-serif text-sm leading-snug text-ink-800 dark:text-paper-100">{d.title}</div>
                  <div className="mt-1 text-center text-[11px] text-ink-400">{d.lastOpenedAt ? `读到 ${pct}% · ${fmt(t.library.lastRead, { page: d.lastPage })}` : `${d.pageCount} 页 · 未开始`}</div>
                </button>
                <button className="absolute -right-1 -top-1 hidden rounded-full bg-paper-0 p-1.5 text-ink-400 shadow-soft hover:text-cinnabar-600 group-hover:block dark:bg-paper-800" onClick={() => removeDoc(d)} title={t.common.delete}><Trash2 size={13} /></button>
              </li>
            );
          })}
        </ul>
      )}
      <TrashDialog open={trashOpen} onClose={() => setTrashOpen(false)} onChanged={refresh} />
      {dialog}
    </>
  );
}

function NovelsTab() {
  const [novels, setNovels] = useState<Array<Novel & { chars: number }>>([]);
  const [trashOpen, setTrashOpen] = useState(false);
  const nav = useNavigate();
  const { confirm, dialog } = useConfirm();
  const refresh = async () => {
    // 字数一次聚合查询拿全，别每本书查一次
    const [list, counts] = await Promise.all([listNovels(), novelCharCounts()]);
    setNovels(list.map((n) => ({ ...n, chars: counts[n.id] ?? 0 })));
  };
  useEffect(() => { void refresh(); }, []);
  const removeNovel = async (n: Novel) => {
    const ok = await confirm({
      title: `把《${n.title || '未命名故事'}》移到回收站？`,
      description: `章节、版本和故事线都会一起留在回收站，${TRASH_RETENTION_DAYS} 天内可以完整恢复。`,
      confirmText: '移到回收站', danger: true,
    });
    if (!ok) return;
    await deleteNovel(n.id);
    toast.success(`已移到回收站：${n.title || '未命名故事'}`);
    await refresh();
  };
  const statusLabel: Record<Novel['status'], string> = { draft: '构思中', planning: '规划中', generating: 'AI 正在写', writing: '写作中', complete: '已完稿' };
  return (
    <>
      <PageHeader title="我的故事" subtitle={novels.length ? `${novels.length} 个故事在书桌上` : '写下一个设想，让 AI 帮你把它变成一本书'}
        actions={<><TrashButton onClick={() => setTrashOpen(true)} /><Button onClick={() => nav('/studio/import')}><Upload size={16} strokeWidth={1.75} />导入文本</Button><Button variant="primary" onClick={() => nav('/studio/new')}><Plus size={16} strokeWidth={1.75} />开始新故事</Button></>} />
      {novels.length === 0 ? (
        <EmptyState icon={<Sparkles size={40} strokeWidth={1.25} />} title="还没有故事" description="告诉 AI 你想看什么样的故事：题材、人物、结局的走向。它会先给你一份大纲，你满意了再让它动笔。" action={<Button variant="primary" onClick={() => nav('/studio/new')}>开始新故事</Button>} />
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-5">
          {novels.map((n) => {
            const pct = n.targetChars ? Math.min(100, Math.round((n.chars / n.targetChars) * 100)) : 0;
            return (
              <li key={n.id} className="group relative flex gap-4 rounded-2xl bg-paper-0 p-4 shadow-soft transition hover:shadow-lift dark:bg-paper-900">
                <button className="flex flex-1 gap-4 text-left" onClick={() => nav(`/studio/${n.id}`)}>
                  <BookCover title={n.title} size="sm" />
                  <div className="min-w-0 flex-1 py-0.5">
                    <div className="line-clamp-1 font-serif text-base font-semibold">{n.title || '未命名故事'}</div>
                    <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-500">{n.premise || n.meta.logline || '还没有写下故事前提'}</div>
                    <div className="mt-3 flex items-center gap-2 text-[11px] text-ink-500">
                      <Badge tone={n.status === 'complete' ? 'green' : n.status === 'generating' ? 'ai' : 'neutral'} dot>{statusLabel[n.status]}</Badge>
                      {n.origin && <Badge tone="amber">二创</Badge>}
                      {n.remote?.currentVersionId && <Badge tone="blue">已发布</Badge>}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <div className="h-1 flex-1 rounded-full bg-paper-200 dark:bg-paper-800"><div className={cn('h-1 rounded-full', n.status === 'complete' ? 'bg-tea-500' : 'bg-cinnabar-500/70')} style={{ width: `${pct}%` }} /></div>
                      <span className="font-serif text-[11px] text-ink-500">{n.chars.toLocaleString()} / {n.targetChars.toLocaleString()} 字</span>
                    </div>
                  </div>
                </button>
                <button className="absolute right-3 top-3 hidden rounded-full p-1.5 text-ink-400 hover:bg-paper-100 hover:text-cinnabar-600 group-hover:block dark:hover:bg-paper-800" onClick={() => removeNovel(n)} title={t.common.delete}><Trash2 size={13} /></button>
              </li>
            );
          })}
        </ul>
      )}
      <TrashDialog open={trashOpen} onClose={() => setTrashOpen(false)} onChanged={refresh} />
      {dialog}
    </>
  );
}
