import { getDb, now, selectOne } from './db';
import { num } from './mappers';
import { listDocuments, type DocumentRow } from './repos/documentsRepo';
import { listNovelIdsDeletedBefore, purgeNovel } from './repos/novelsRepo';
import { dropSearchIndex } from '@/db/repos/documentsRepo';

/** 回收站保留天数：超过就在下次启动时硬删。 */
export const TRASH_RETENTION_DAYS = 30;
export const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
/** 存 PDF 的相对目录（与 pdf/import.ts 的 PDF_DIR 一致，此处不引入避免带进 pdfjs）。 */
export const PDF_DIR = 'pdfs';

export function trashExpiresAt(deletedAt: number): number {
  return deletedAt + TRASH_RETENTION_MS;
}
export function isTrashExpired(deletedAt: number, at: number = Date.now()): boolean {
  return at >= trashExpiresAt(deletedAt);
}
/** 还能后悔几天（向上取整，最少 0）。 */
export function trashDaysLeft(deletedAt: number, at: number = Date.now()): number {
  return Math.max(0, Math.ceil((trashExpiresAt(deletedAt) - at) / (24 * 60 * 60 * 1000)));
}

/** 磁盘上有、数据库里没有的 PDF：孤儿文件。比较用相对路径，两边都做一次规范化。 */
export function findOrphanPdfs(onDisk: string[], referenced: string[]): string[] {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');
  const known = new Set(referenced.map(norm));
  return onDisk.filter((p) => !known.has(norm(p)));
}

// ── 文件系统这一层可替换，测试里塞假的即可 ────────────────────────────────

export interface MaintenanceFs {
  /** 删除 appdata 下的相对路径；文件本来就不在算成功。 */
  removeIfExists(relPath: string): Promise<void>;
  /** 列出 appdata/pdfs 下的文件，返回相对 appdata 的路径。 */
  listPdfFiles(): Promise<string[]>;
}

const tauriFs: MaintenanceFs = {
  async removeIfExists(relPath) {
    const { BaseDirectory, exists, remove } = await import('@tauri-apps/plugin-fs');
    if (!(await exists(relPath, { baseDir: BaseDirectory.AppData }))) return;
    await remove(relPath, { baseDir: BaseDirectory.AppData });
  },
  async listPdfFiles() {
    const { BaseDirectory, exists, readDir } = await import('@tauri-apps/plugin-fs');
    if (!(await exists(PDF_DIR, { baseDir: BaseDirectory.AppData }))) return [];
    const entries = await readDir(PDF_DIR, { baseDir: BaseDirectory.AppData });
    return entries.filter((e) => e.isFile).map((e) => `${PDF_DIR}/${e.name}`);
  },
};

// ── 文档的回收站操作 ──────────────────────────────────────────────────────
// documentsRepo 由别的模块负责，这里只补软删相关的查询，不改它的接口。

export interface TrashedDocument { id: string; title: string; author: string | null; fileRelPath: string; deletedAt: number }
interface RawTrashed { id: string; title: string; author: string | null; file_rel_path: string; deleted_at: number }

export async function softDeleteDocument(id: string): Promise<void> {
  await getDb().execute('UPDATE documents SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', [now(), id]);
}
export async function restoreDocument(id: string): Promise<void> {
  await getDb().execute('UPDATE documents SET deleted_at = NULL WHERE id = ?', [id]);
}
export async function isDocumentTrashed(id: string): Promise<boolean> {
  const r = await selectOne<{ deleted_at: number | null }>('SELECT deleted_at FROM documents WHERE id = ?', [id]);
  return !!r && r.deleted_at != null;
}
export async function listTrashedDocuments(): Promise<TrashedDocument[]> {
  const rows = await getDb().select<RawTrashed>(
    'SELECT id, title, author, file_rel_path, deleted_at FROM documents WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC',
  );
  return rows.map((r) => ({ id: r.id, title: r.title, author: r.author, fileRelPath: r.file_rel_path, deletedAt: num(r.deleted_at) }));
}
/** 书架用：listDocuments() 去掉回收站里的。 */
export async function listActiveDocuments(): Promise<DocumentRow[]> {
  const trashed = new Set((await listTrashedDocuments()).map((d) => d.id));
  return (await listDocuments()).filter((d) => !trashed.has(d.id));
}

/**
 * 永久删除一个文档：先删文件，再删数据库行。
 * 顺序很重要——文件删失败就把行留着，下次启动再试，绝不产生找不到主人的 PDF。
 */
export async function purgeDocument(id: string, fs: MaintenanceFs = tauriFs): Promise<void> {
  const row = await selectOne<{ file_rel_path: string }>('SELECT file_rel_path FROM documents WHERE id = ?', [id]);
  if (!row) return;
  await fs.removeIfExists(row.file_rel_path);
  // 全文检索是虚拟表，吃不到外键级联，得手动清。
  await dropSearchIndex(id);
  await getDb().execute('DELETE FROM documents WHERE id = ?', [id]);
}

// ── 启动清理 ─────────────────────────────────────────────────────────────

export interface MaintenanceReport {
  purgedNovels: number;
  purgedDocuments: number;
  removedOrphans: string[];
  failures: string[];
}

/** 清掉回收站里超过保留期的记录。 */
export async function purgeExpiredTrash(at: number = Date.now(), fs: MaintenanceFs = tauriFs): Promise<{ novels: number; documents: number; failures: string[] }> {
  const cutoff = at - TRASH_RETENTION_MS;
  const failures: string[] = [];
  let novels = 0;
  for (const id of await listNovelIdsDeletedBefore(cutoff)) {
    try { await purgeNovel(id); novels += 1; } catch (e) { failures.push(`小说 ${id}：${msg(e)}`); }
  }
  const docRows = await getDb().select<{ id: string }>('SELECT id FROM documents WHERE deleted_at IS NOT NULL AND deleted_at < ?', [cutoff]);
  let documents = 0;
  for (const r of docRows) {
    try { await purgeDocument(r.id, fs); documents += 1; } catch (e) { failures.push(`文档 ${r.id}：${msg(e)}`); }
  }
  return { novels, documents, failures };
}

/** 删掉磁盘上没有对应数据库行的 PDF（软删的文档仍算有主）。 */
export async function cleanupOrphanPdfs(fs: MaintenanceFs = tauriFs): Promise<{ removed: string[]; failures: string[] }> {
  const rows = await getDb().select<{ file_rel_path: string }>('SELECT file_rel_path FROM documents');
  const orphans = findOrphanPdfs(await fs.listPdfFiles(), rows.map((r) => r.file_rel_path));
  const removed: string[] = [];
  const failures: string[] = [];
  for (const p of orphans) {
    try { await fs.removeIfExists(p); removed.push(p); } catch (e) { failures.push(`${p}：${msg(e)}`); }
  }
  return { removed, failures };
}

/** 启动时跑一次：过期回收站 + 孤儿文件。任何一步出错都只记录，不阻断启动。 */
export async function runStartupMaintenance(at: number = Date.now(), fs: MaintenanceFs = tauriFs): Promise<MaintenanceReport> {
  const report: MaintenanceReport = { purgedNovels: 0, purgedDocuments: 0, removedOrphans: [], failures: [] };
  try {
    const trash = await purgeExpiredTrash(at, fs);
    report.purgedNovels = trash.novels;
    report.purgedDocuments = trash.documents;
    report.failures.push(...trash.failures);
  } catch (e) { report.failures.push(`清理回收站：${msg(e)}`); }
  try {
    const orphans = await cleanupOrphanPdfs(fs);
    report.removedOrphans = orphans.removed;
    report.failures.push(...orphans.failures);
  } catch (e) { report.failures.push(`清理孤儿文件：${msg(e)}`); }
  return report;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
