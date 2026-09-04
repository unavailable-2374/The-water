import { open } from '@tauri-apps/plugin-dialog';
import { copyFile, exists, mkdir, readFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { sha256Hex } from '@the-water/shared';
import { createDocument, findDocumentBySha, type DocumentRow } from '@/db/repos/documentsRepo';
import { closePdf, openPdfFromBytes } from '@/pdf/pdfjs';
import { KNOWN_UNSUPPORTED_EXTENSIONS, READABLE_EXTENSIONS, extensionOf, kindFromPath, storageDirFor, storageExtension, titleFromPath } from './kind';
import { startIndexing } from './indexQueue';
import { decodeText } from './open';
import { CHARS_PER_PAGE, paginateBlocks, parseBlocks } from './textPaginate';

export type ImportResult =
  | { status: 'imported'; doc: DocumentRow }
  | { status: 'duplicate'; doc: DocumentRow }
  | { status: 'unsupported'; path: string; message: string }
  | { status: 'error'; error: string; path: string };

/** 文件选择器：PDF / TXT / Markdown。 */
export async function pickDocumentFiles(): Promise<string[]> {
  const picked = await open({
    multiple: true,
    filters: [{ name: '可以阅读的文档', extensions: [...READABLE_EXTENSIONS] }],
  });
  if (!picked) return [];
  return Array.isArray(picked) ? picked : [picked];
}

/** 从一堆路径里挑出能导入的（拖拽时用）。 */
export function filterImportable(paths: string[]): { accepted: string[]; rejected: string[] } {
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const p of paths) {
    const ext = extensionOf(p);
    if ((READABLE_EXTENSIONS as readonly string[]).includes(ext)) accepted.push(p);
    else rejected.push(p);
  }
  return { accepted, rejected };
}

/** 把文档复制进 appdata，读元数据，落 documents 行。同一份文件（按 sha256）只入库一次。 */
export async function importDocument(srcPath: string): Promise<ImportResult> {
  const kind = kindFromPath(srcPath);
  if (!kind) return { status: 'unsupported', path: srcPath, message: '认不出这个文件的格式，目前支持 PDF、TXT 和 Markdown。' };
  if ((KNOWN_UNSUPPORTED_EXTENSIONS as readonly string[]).includes(extensionOf(srcPath))) {
    return { status: 'unsupported', path: srcPath, message: 'EPUB 阅读还没做好，暂时请先转成 TXT 或 PDF。' };
  }
  try {
    const bytes = await readFile(srcPath);
    const sha = await sha256Hex(bytes);
    const existing = await findDocumentBySha(sha);
    if (existing) return { status: 'duplicate', doc: existing };
    const dir = storageDirFor(kind);
    if (!(await exists(dir, { baseDir: BaseDirectory.AppData }))) await mkdir(dir, { baseDir: BaseDirectory.AppData, recursive: true });
    const rel = `${dir}/${sha}.${storageExtension(kind)}`;
    await copyFile(srcPath, rel, { toPathBaseDir: BaseDirectory.AppData });
    let pageCount = 0;
    let title = titleFromPath(srcPath);
    let author: string | null = null;
    if (kind === 'pdf') {
      try {
        const pdf = await openPdfFromBytes(bytes);
        pageCount = pdf.numPages;
        const meta = (await pdf.getMetadata().catch(() => null)) as { info?: { Title?: string; Author?: string } } | null;
        if (meta?.info?.Title && meta.info.Title.trim()) title = meta.info.Title.trim();
        if (meta?.info?.Author) author = meta.info.Author;
        await closePdf(pdf);
      } catch {
        /* 元数据尽力而为 */
      }
    } else {
      const text = decodeText(bytes);
      pageCount = paginateBlocks(parseBlocks(text, kind), CHARS_PER_PAGE).length;
      const first = /^#\s+(.+)$/m.exec(text);
      if (kind === 'md' && first?.[1]) title = first[1].trim();
    }
    const doc = await createDocument({ title, fileRelPath: rel, fileSha256: sha, pageCount, author });
    // 导入即开始后台建索引：不阻塞书架，也不用等到第一次打开
    startIndexing(doc);
    return { status: 'imported', doc };
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e), path: srcPath };
  }
}

export async function importDocuments(paths: string[]): Promise<ImportResult[]> {
  const out: ImportResult[] = [];
  for (const p of paths) out.push(await importDocument(p));
  return out;
}
