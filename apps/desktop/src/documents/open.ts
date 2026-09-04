import { readFile } from '@tauri-apps/plugin-fs';
import { BaseDirectory } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import type { DocumentRow } from '@/db/repos/documentsRepo';
import { openPdf } from '@/pdf/pdfjs';
import { decodeText } from './decode';
import { epubDocumentSource } from './epubSource';
import { kindFromPath } from './kind';
import { pdfDocumentSource } from './pdfSource';
import { textDocumentSource } from './textSource';
import { EncryptedDocumentError, UnsupportedDocumentError, type DocumentSource } from './types';

export async function absolutePathFor(relPath: string): Promise<string> {
  return join(await appDataDir(), relPath);
}

// decodeText 搬到了 ./decode，这里再导出一次，保持既有引用不变。
export { decodeText };

/**
 * 按文件类型打开对应的「文档源」。
 * 认不出或还不支持的格式抛 UnsupportedDocumentError，加密文档抛 EncryptedDocumentError，
 * 阅读器据此给明确提示，而不是白屏。
 */
export async function openDocumentSource(doc: Pick<DocumentRow, 'fileRelPath'>): Promise<DocumentSource> {
  const kind = kindFromPath(doc.fileRelPath);
  if (kind === 'epub') {
    const bytes = await readFile(doc.fileRelPath, { baseDir: BaseDirectory.AppData });
    return epubDocumentSource(bytes);
  }
  if (kind === 'txt' || kind === 'md') {
    const bytes = await readFile(doc.fileRelPath, { baseDir: BaseDirectory.AppData });
    return textDocumentSource(decodeText(bytes), kind);
  }
  if (kind !== 'pdf') {
    throw new UnsupportedDocumentError(kind ?? 'unknown', '这个格式还读不了，目前支持 PDF、EPUB、TXT 和 Markdown。');
  }
  try {
    const pdf = await openPdf(await absolutePathFor(doc.fileRelPath));
    return pdfDocumentSource(pdf);
  } catch (e) {
    if (isPasswordException(e)) throw new EncryptedDocumentError();
    throw e;
  }
}

function isPasswordException(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name ?? '';
  const msg = e instanceof Error ? e.message : String(e);
  return name === 'PasswordException' || /password/i.test(msg);
}
