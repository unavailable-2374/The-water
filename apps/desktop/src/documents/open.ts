import { readFile } from '@tauri-apps/plugin-fs';
import { BaseDirectory } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import type { DocumentRow } from '@/db/repos/documentsRepo';
import { openPdf } from '@/pdf/pdfjs';
import { kindFromPath } from './kind';
import { pdfDocumentSource } from './pdfSource';
import { textDocumentSource } from './textSource';
import { EncryptedDocumentError, UnsupportedDocumentError, type DocumentSource } from './types';

export async function absolutePathFor(relPath: string): Promise<string> {
  return join(await appDataDir(), relPath);
}

/** 尽量正确地把书稿字节解成文字：先按 UTF-8，失败再试 GBK。 */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('gbk').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}

/**
 * 按文件类型打开对应的「文档源」。
 * 认不出或还不支持的格式抛 UnsupportedDocumentError，加密文档抛 EncryptedDocumentError，
 * 阅读器据此给明确提示，而不是白屏。
 */
export async function openDocumentSource(doc: Pick<DocumentRow, 'fileRelPath'>): Promise<DocumentSource> {
  const kind = kindFromPath(doc.fileRelPath);
  if (kind === 'epub') {
    throw new UnsupportedDocumentError('epub', 'EPUB 阅读还没做好。文档源接口已经就位，等排版层接上就能读，暂时请先转成 TXT 或 PDF。');
  }
  if (kind === 'txt' || kind === 'md') {
    const bytes = await readFile(doc.fileRelPath, { baseDir: BaseDirectory.AppData });
    return textDocumentSource(decodeText(bytes), kind);
  }
  if (kind !== 'pdf') {
    throw new UnsupportedDocumentError(kind ?? 'unknown', '这个格式还读不了，目前支持 PDF、TXT 和 Markdown。');
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
