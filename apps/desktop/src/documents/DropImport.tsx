import { useEffect, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { FileDown } from 'lucide-react';
import { toast } from '@/components/Toast';
import { filterImportable, importDocuments } from './import';

/** 导入完成后广播一下，书架收到就刷新列表。 */
export const DOCUMENTS_IMPORTED_EVENT = 'the-water:documents-imported';

/**
 * 窗口级拖拽导入：把 PDF / EPUB / TXT / Markdown 拖进窗口任意位置即可入库。
 * 挂在应用外壳上就一直生效，不依赖当前在哪一页。
 */
export function DropImport() {
  const [hovering, setHovering] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWebview()
      .onDragDropEvent(async (event) => {
        const payload = event.payload;
        if (payload.type === 'enter' || payload.type === 'over') { setHovering(true); return; }
        if (payload.type === 'leave') { setHovering(false); return; }
        setHovering(false);
        const { accepted, rejected } = filterImportable(payload.paths);
        if (accepted.length === 0) {
          toast.info('只能拖入 PDF、EPUB、TXT 或 Markdown');
          return;
        }
        setBusy(true);
        try {
          const results = await importDocuments(accepted);
          let ok = 0;
          for (const r of results) {
            if (r.status === 'imported') ok++;
            else if (r.status === 'duplicate') toast.info(`书架上已经有了：${r.doc.title}`);
            else if (r.status === 'unsupported') toast.info(r.message);
            else toast.error(`导入失败：${r.error}`);
          }
          if (ok > 0) {
            toast.success(`已放上书架：${ok} 本`);
            window.dispatchEvent(new CustomEvent(DOCUMENTS_IMPORTED_EVENT));
          }
          if (rejected.length) toast.info(`有 ${rejected.length} 个文件读不了，已跳过`);
        } finally {
          setBusy(false);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, []);

  if (!hovering && !busy) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[80] flex items-center justify-center bg-ink-900/25 backdrop-blur-[2px]">
      <div className="flex flex-col items-center gap-3 rounded-3xl bg-paper-0 px-10 py-8 shadow-lift dark:bg-paper-900">
        <FileDown size={32} strokeWidth={1.25} className="text-tea-600" />
        <p className="font-serif text-sm text-ink-700 dark:text-paper-100">{busy ? '正在放上书架…' : '松手就放上书架'}</p>
        <p className="font-serif text-xs text-ink-400">支持 PDF、EPUB、TXT、Markdown</p>
      </div>
    </div>
  );
}
