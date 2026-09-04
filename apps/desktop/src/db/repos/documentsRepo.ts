import { nanoid } from 'nanoid';
import { getDb, now, selectOne } from '../db';
import { num, nullableNum, parseJsonLoose } from '../mappers';

export interface DocumentRow {
  id: string; title: string; fileRelPath: string; fileSha256: string; pageCount: number; author: string | null;
  importedAt: number; lastOpenedAt: number | null; lastPage: number; lastZoom: number; textIndexed: boolean;
  meta: Record<string, unknown>;
}
interface Raw {
  id: string; title: string; file_rel_path: string; file_sha256: string; page_count: number; author: string | null;
  imported_at: number; last_opened_at: number | null; last_page: number; last_zoom: number; text_indexed: number; meta: string;
}
const map = (r: Raw): DocumentRow => ({
  id: r.id, title: r.title, fileRelPath: r.file_rel_path, fileSha256: r.file_sha256, pageCount: num(r.page_count),
  author: r.author, importedAt: r.imported_at, lastOpenedAt: nullableNum(r.last_opened_at), lastPage: num(r.last_page, 1),
  lastZoom: num(r.last_zoom, 1), textIndexed: r.text_indexed === 1, meta: parseJsonLoose(r.meta, {}),
});

export async function listDocuments(): Promise<DocumentRow[]> {
  return (await getDb().select<Raw>('SELECT * FROM documents ORDER BY COALESCE(last_opened_at, imported_at) DESC')).map(map);
}
export async function getDocument(id: string): Promise<DocumentRow | null> {
  const r = await selectOne<Raw>('SELECT * FROM documents WHERE id = ?', [id]);
  return r ? map(r) : null;
}
export async function findDocumentBySha(sha: string): Promise<DocumentRow | null> {
  const r = await selectOne<Raw>('SELECT * FROM documents WHERE file_sha256 = ?', [sha]);
  return r ? map(r) : null;
}
export async function createDocument(input: { title: string; fileRelPath: string; fileSha256: string; pageCount: number; author?: string | null }): Promise<DocumentRow> {
  const id = nanoid();
  await getDb().execute(
    'INSERT INTO documents(id, title, file_rel_path, file_sha256, page_count, author, imported_at, last_page, last_zoom) VALUES (?,?,?,?,?,?,?,1,1.0)',
    [id, input.title, input.fileRelPath, input.fileSha256, input.pageCount, input.author ?? null, now()],
  );
  return (await getDocument(id))!;
}
export async function touchDocument(id: string, patch: { lastPage?: number; lastZoom?: number; title?: string }): Promise<void> {
  const cur = await getDocument(id);
  if (!cur) return;
  await getDb().execute('UPDATE documents SET last_opened_at = ?, last_page = ?, last_zoom = ?, title = ? WHERE id = ?', [
    now(), patch.lastPage ?? cur.lastPage, patch.lastZoom ?? cur.lastZoom, patch.title ?? cur.title, id,
  ]);
}
export async function deleteDocument(id: string): Promise<void> {
  await getDb().execute('DELETE FROM documents WHERE id = ?', [id]);
}
export async function upsertPageText(documentId: string, pageNo: number, text: string): Promise<void> {
  await getDb().execute(
    'INSERT INTO document_pages(document_id, page_no, text) VALUES (?,?,?) ON CONFLICT(document_id, page_no) DO UPDATE SET text = excluded.text',
    [documentId, pageNo, text],
  );
}
export async function markTextIndexed(documentId: string, pageCount: number): Promise<void> {
  await getDb().execute('UPDATE documents SET text_indexed = 1, page_count = ? WHERE id = ?', [pageCount, documentId]);
}
export async function getPageText(documentId: string, pageNo: number): Promise<string | null> {
  const r = await selectOne<{ text: string }>('SELECT text FROM document_pages WHERE document_id = ? AND page_no = ?', [documentId, pageNo]);
  return r?.text ?? null;
}
export async function searchPages(documentId: string, q: string, limit = 50): Promise<Array<{ pageNo: number; snippet: string }>> {
  const rows = await getDb().select<{ page_no: number; text: string }>(
    'SELECT page_no, text FROM document_pages WHERE document_id = ? AND text LIKE ? ORDER BY page_no LIMIT ?',
    [documentId, `%${q}%`, limit],
  );
  return rows.map((r) => {
    const i = r.text.indexOf(q);
    const s = Math.max(0, i - 30);
    return { pageNo: r.page_no, snippet: r.text.slice(s, i + q.length + 30) };
  });
}
