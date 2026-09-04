import { open } from '@tauri-apps/plugin-dialog';
import { copyFile, exists, mkdir, readFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import { sha256Hex } from '@the-water/shared';
import { createDocument, findDocumentBySha, type DocumentRow } from '@/db/repos/documentsRepo';
import { closePdf, openPdfFromBytes } from './pdfjs';

export const PDF_DIR = 'pdfs';

export async function pickPdfFiles(): Promise<string[]> {
  const picked = await open({ multiple: true, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (!picked) return [];
  return Array.isArray(picked) ? picked : [picked];
}

export async function absolutePathFor(relPath: string): Promise<string> {
  return join(await appDataDir(), relPath);
}

export type ImportResult = { status: 'imported'; doc: DocumentRow } | { status: 'duplicate'; doc: DocumentRow } | { status: 'error'; error: string; path: string };

/** Copy the PDF into appdata/pdfs/<sha>.pdf, read metadata, create the documents row. */
export async function importPdf(srcPath: string): Promise<ImportResult> {
  try {
    const bytes = await readFile(srcPath);
    const sha = await sha256Hex(bytes);
    const existing = await findDocumentBySha(sha);
    if (existing) return { status: 'duplicate', doc: existing };
    if (!(await exists(PDF_DIR, { baseDir: BaseDirectory.AppData }))) await mkdir(PDF_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
    const rel = `${PDF_DIR}/${sha}.pdf`;
    await copyFile(srcPath, rel, { toPathBaseDir: BaseDirectory.AppData });
    let pageCount = 0;
    let title = fileTitle(srcPath);
    let author: string | null = null;
    try {
      const pdf = await openPdfFromBytes(bytes);
      pageCount = pdf.numPages;
      const meta = (await pdf.getMetadata().catch(() => null)) as { info?: { Title?: string; Author?: string } } | null;
      if (meta?.info?.Title && meta.info.Title.trim()) title = meta.info.Title.trim();
      if (meta?.info?.Author) author = meta.info.Author;
      await closePdf(pdf);
    } catch {
      /* metadata is best-effort */
    }
    const doc = await createDocument({ title, fileRelPath: rel, fileSha256: sha, pageCount, author });
    return { status: 'imported', doc };
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e), path: srcPath };
  }
}

function fileTitle(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name.replace(/\.pdf$/i, '');
}
