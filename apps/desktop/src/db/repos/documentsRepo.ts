import { nanoid } from 'nanoid';
import { getDb, now, selectOne } from '../db';
import { num, nullableNum, parseJsonLoose } from '../mappers';
import { ftsIndexText, ftsMatchQuery } from '@/documents/fts';

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
  return (await getDb().select<Raw>('SELECT * FROM documents WHERE deleted_at IS NULL ORDER BY COALESCE(last_opened_at, imported_at) DESC')).map(map);
}
export async function getDocument(id: string): Promise<DocumentRow | null> {
  const r = await selectOne<Raw>('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL', [id]);
  return r ? map(r) : null;
}
/** 注意：导入去重与「重新导入同一份文件时从回收站捞回」都依赖它能看到软删行，这里不过滤 deleted_at。 */
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
export async function upsertPageText(documentId: string, pageNo: number, text: string): Promise<void> {
  await getDb().execute(
    'INSERT INTO document_pages(document_id, page_no, text) VALUES (?,?,?) ON CONFLICT(document_id, page_no) DO UPDATE SET text = excluded.text',
    [documentId, pageNo, text],
  );
  await indexPageInFts(documentId, pageNo, text);
}
export async function markTextIndexed(documentId: string, pageCount: number): Promise<void> {
  await getDb().execute('UPDATE documents SET text_indexed = 1, page_count = ? WHERE id = ?', [pageCount, documentId]);
}
export async function getPageText(documentId: string, pageNo: number): Promise<string | null> {
  const r = await selectOne<{ text: string }>('SELECT text FROM document_pages WHERE document_id = ? AND page_no = ?', [documentId, pageNo]);
  return r?.text ?? null;
}
/** 批量取页文本：高亮重定位时按页取，避免逐条查询。 */
export async function getPageTexts(documentId: string, pageNos: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const uniq = [...new Set(pageNos)].filter((n) => Number.isInteger(n) && n > 0);
  if (uniq.length === 0) return out;
  const rows = await getDb().select<{ page_no: number; text: string }>(
    `SELECT page_no, text FROM document_pages WHERE document_id = ? AND page_no IN (${uniq.map(() => '?').join(',')})`,
    [documentId, ...uniq],
  );
  for (const r of rows) out.set(num(r.page_no), r.text);
  return out;
}

/** 已经存了多少页文本，用于判断后台索引是否已完成。 */
export async function indexedPageCount(documentId: string): Promise<number> {
  const r = await selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM document_pages WHERE document_id = ?', [documentId]);
  return num(r?.n ?? 0);
}

// ---------- 全文检索 ----------

let ftsSupported: boolean | null = null;

/** FTS5 虚拟表是否可用；不可用时全部检索路径回退到 LIKE。 */
export async function isFtsAvailable(): Promise<boolean> {
  if (ftsSupported !== null) return ftsSupported;
  try {
    await getDb().select('SELECT rowid FROM document_pages_fts LIMIT 1');
    ftsSupported = true;
  } catch {
    ftsSupported = false;
  }
  return ftsSupported;
}

/** 只给测试用：清掉可用性缓存。 */
export function resetFtsAvailability(): void {
  ftsSupported = null;
}

async function indexPageInFts(documentId: string, pageNo: number, text: string): Promise<void> {
  if (!(await isFtsAvailable())) return;
  try {
    await getDb().execute('DELETE FROM document_pages_fts WHERE doc_id = ? AND page_no = ?', [documentId, pageNo]);
    await getDb().execute('INSERT INTO document_pages_fts(doc_id, page_no, body) VALUES (?,?,?)', [documentId, pageNo, ftsIndexText(text)]);
  } catch {
    ftsSupported = false;
  }
}

/** 删除一本书的检索数据（documents 行的级联删不到虚拟表）。 */
export async function dropSearchIndex(documentId: string): Promise<void> {
  if (!(await isFtsAvailable())) return;
  try {
    await getDb().execute('DELETE FROM document_pages_fts WHERE doc_id = ?', [documentId]);
  } catch {
    /* 检索索引清不掉不影响删书 */
  }
}

/** 清掉已经没有主人的检索行（书被永久删除时虚拟表不会跟着走）。 */
export async function pruneOrphanSearchIndex(): Promise<void> {
  if (!(await isFtsAvailable())) return;
  try {
    await getDb().execute('DELETE FROM document_pages_fts WHERE doc_id NOT IN (SELECT id FROM documents)');
  } catch {
    /* 尽力而为 */
  }
}

/**
 * 补齐检索索引：老书在建 FTS 表之前就已经存过页文本，这里按需回填。
 * 返回回填的页数。
 */
export async function ensureSearchIndex(documentId: string): Promise<number> {
  if (!(await isFtsAvailable())) return 0;
  try {
    const have = new Set(
      (await getDb().select<{ page_no: number }>('SELECT page_no FROM document_pages_fts WHERE doc_id = ?', [documentId])).map((r) => num(r.page_no)),
    );
    const pages = await getDb().select<{ page_no: number; text: string }>('SELECT page_no, text FROM document_pages WHERE document_id = ?', [documentId]);
    let done = 0;
    for (const p of pages) {
      if (have.has(num(p.page_no))) continue;
      await indexPageInFts(documentId, num(p.page_no), p.text);
      done++;
    }
    return done;
  } catch {
    ftsSupported = false;
    return 0;
  }
}

export interface PageSearchRow { pageNo: number; text: string }
export interface PageSearchResult {
  pages: PageSearchRow[];
  /** 命中页数被 limit 截断 */
  truncated: boolean;
  engine: 'fts' | 'like';
}

/** 找出含有关键词的页（连同整页文本，命中位置与片段由 documents/search.ts 计算）。 */
export async function searchPageTexts(documentId: string, q: string, limit = 200): Promise<PageSearchResult> {
  const query = q.trim();
  if (!query) return { pages: [], truncated: false, engine: (await isFtsAvailable()) ? 'fts' : 'like' };
  const match = ftsMatchQuery(query);
  if (match && (await isFtsAvailable())) {
    try {
      const rows = await getDb().select<{ page_no: number; text: string }>(
        `SELECT p.page_no AS page_no, p.text AS text
           FROM document_pages_fts f
           JOIN document_pages p ON p.document_id = f.doc_id AND p.page_no = f.page_no
          WHERE f.body MATCH ? AND f.doc_id = ?
          ORDER BY p.page_no
          LIMIT ?`,
        [match, documentId, limit + 1],
      );
      return { pages: rows.slice(0, limit).map((r) => ({ pageNo: num(r.page_no), text: r.text })), truncated: rows.length > limit, engine: 'fts' };
    } catch {
      ftsSupported = false;
    }
  }
  const rows = await getDb().select<{ page_no: number; text: string }>(
    'SELECT page_no, text FROM document_pages WHERE document_id = ? AND text LIKE ? ESCAPE \'\\\' ORDER BY page_no LIMIT ?',
    [documentId, `%${likeEscape(query)}%`, limit + 1],
  );
  return { pages: rows.slice(0, limit).map((r) => ({ pageNo: num(r.page_no), text: r.text })), truncated: rows.length > limit, engine: 'like' };
}

/** LIKE 通配符转义，避免用户输入的 % 和 _ 变成通配。 */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}
