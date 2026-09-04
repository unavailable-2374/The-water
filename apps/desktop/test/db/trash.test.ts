import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { getDb } from '@/db/db';
import { createNovel, deleteNovel, getNovel, listNovels, listNovelIdsDeletedBefore, listTrashedNovels, purgeNovel, restoreNovel } from '@/db/repos/novelsRepo';
import { createVersion, listChapters, novelCharCount, novelCharCounts, upsertChapterPlan } from '@/db/repos/chaptersRepo';
import { createDocument, findDocumentBySha, listDocuments } from '@/db/repos/documentsRepo';
import {
  TRASH_RETENTION_DAYS, TRASH_RETENTION_MS, cleanupOrphanPdfs, findOrphanPdfs, isDocumentTrashed, isTrashExpired,
  listActiveDocuments, listTrashedDocuments, purgeDocument, purgeExpiredTrash, restoreDocument, runStartupMaintenance,
  softDeleteDocument, trashDaysLeft, trashExpiresAt, type MaintenanceFs,
} from '@/db/maintenance';
import { defaultRequirements } from '@/novel/types';

beforeEach(() => { useTestDb(); });

/** 记录调用的假文件系统。 */
function fakeFs(files: string[]): MaintenanceFs & { removed: string[]; failOn?: string } {
  const state = {
    removed: [] as string[],
    failOn: undefined as string | undefined,
    async removeIfExists(rel: string) {
      if (state.failOn === rel) throw new Error('磁盘忙');
      state.removed.push(rel);
      const i = files.indexOf(rel);
      if (i >= 0) files.splice(i, 1);
    },
    async listPdfFiles() { return [...files]; },
  };
  return state;
}

const makeNovel = (title: string) => createNovel({ title, premise: 'p', requirements: defaultRequirements(), targetChars: 1000 });

describe('小说软删除与回收站', () => {
  it('删除只是打标记，恢复后章节完好', async () => {
    const n = await makeNovel('甲');
    const ch = await upsertChapterPlan(n.id, { chapterNo: 1, title: '起', targetChars: 100 });
    await createVersion({ chapterId: ch.id, content: '一二三四五', source: 'generated' });

    await deleteNovel(n.id);
    expect(await listNovels()).toHaveLength(0);
    expect(await getNovel(n.id)).toBeNull();
    // 章节没被级联删掉
    expect(await getDb().select('SELECT * FROM chapters WHERE novel_id = ?', [n.id])).toHaveLength(1);

    const trashed = await listTrashedNovels();
    expect(trashed).toHaveLength(1);
    expect(trashed[0]!.title).toBe('甲');
    expect(trashed[0]!.deletedAt).toBeGreaterThan(0);

    await restoreNovel(n.id);
    expect((await listNovels()).map((x) => x.id)).toEqual([n.id]);
    expect(await listChapters(n.id)).toHaveLength(1);
    expect(await novelCharCount(n.id)).toBe(5);
  });

  it('重复删除不刷新删除时间', async () => {
    const n = await makeNovel('乙');
    await deleteNovel(n.id);
    const first = (await listTrashedNovels())[0]!.deletedAt;
    await getDb().execute('UPDATE novels SET deleted_at = ? WHERE id = ?', [first - 1000, n.id]);
    await deleteNovel(n.id);
    expect((await listTrashedNovels())[0]!.deletedAt).toBe(first - 1000);
  });

  it('永久删除会级联清掉章节与版本', async () => {
    const n = await makeNovel('丙');
    const ch = await upsertChapterPlan(n.id, { chapterNo: 1 });
    await createVersion({ chapterId: ch.id, content: '正文', source: 'generated' });
    await deleteNovel(n.id);
    await purgeNovel(n.id);
    expect(await listTrashedNovels()).toHaveLength(0);
    expect(await getDb().select('SELECT * FROM chapters WHERE novel_id = ?', [n.id])).toHaveLength(0);
    expect(await getDb().select('SELECT * FROM chapter_versions WHERE chapter_id = ?', [ch.id])).toHaveLength(0);
  });

  it('按 cutoff 找过期记录', async () => {
    const a = await makeNovel('过期');
    const b = await makeNovel('刚删');
    await deleteNovel(a.id);
    await deleteNovel(b.id);
    await getDb().execute('UPDATE novels SET deleted_at = ? WHERE id = ?', [Date.now() - TRASH_RETENTION_MS - 1, a.id]);
    expect(await listNovelIdsDeletedBefore(Date.now() - TRASH_RETENTION_MS)).toEqual([a.id]);
  });
});

describe('文档软删除', () => {
  const mkDoc = (sha: string) => createDocument({ title: `书${sha}`, fileRelPath: `pdfs/${sha}.pdf`, fileSha256: sha, pageCount: 3 });

  it('软删后不在书架，回收站里能看到并恢复', async () => {
    const d = await mkDoc('aa');
    await softDeleteDocument(d.id);
    expect(await listActiveDocuments()).toHaveLength(0);
    expect(await listTrashedDocuments()).toHaveLength(1); // 行还在，只是被 listDocuments 的软删过滤挡住了
    expect(await isDocumentTrashed(d.id)).toBe(true);
    const trashed = await listTrashedDocuments();
    expect(trashed[0]!.fileRelPath).toBe('pdfs/aa.pdf');
    await restoreDocument(d.id);
    expect(await isDocumentTrashed(d.id)).toBe(false);
    expect(await listActiveDocuments()).toHaveLength(1);
  });

  it('重复导入同一份 PDF 时仍能按 sha 找回回收站里的记录', async () => {
    const d = await mkDoc('bb');
    await softDeleteDocument(d.id);
    expect((await findDocumentBySha('bb'))!.id).toBe(d.id);
  });

  it('永久删除：先删文件再删行', async () => {
    const files = ['pdfs/cc.pdf'];
    const fs = fakeFs(files);
    const d = await mkDoc('cc');
    await softDeleteDocument(d.id);
    await purgeDocument(d.id, fs);
    expect(fs.removed).toEqual(['pdfs/cc.pdf']);
    expect(await listDocuments()).toHaveLength(0);
  });

  it('删文件失败时数据库行留着，不产生孤儿文件', async () => {
    const files = ['pdfs/dd.pdf'];
    const fs = fakeFs(files);
    fs.failOn = 'pdfs/dd.pdf';
    const d = await mkDoc('dd');
    await softDeleteDocument(d.id);
    await expect(purgeDocument(d.id, fs)).rejects.toThrow('磁盘忙');
    expect(await listTrashedDocuments()).toHaveLength(1);
    expect(files).toEqual(['pdfs/dd.pdf']);
  });
});

describe('保留期判定', () => {
  const day = 24 * 60 * 60 * 1000;
  it('30 天到期', () => {
    expect(TRASH_RETENTION_DAYS).toBe(30);
    const t0 = 1_700_000_000_000;
    expect(trashExpiresAt(t0)).toBe(t0 + 30 * day);
    expect(isTrashExpired(t0, t0 + 29 * day)).toBe(false);
    expect(isTrashExpired(t0, t0 + 30 * day)).toBe(true);
    expect(trashDaysLeft(t0, t0)).toBe(30);
    expect(trashDaysLeft(t0, t0 + 29.5 * day)).toBe(1);
    expect(trashDaysLeft(t0, t0 + 40 * day)).toBe(0);
  });
});

describe('孤儿文件', () => {
  it('磁盘上有、库里没有的才算孤儿', () => {
    expect(findOrphanPdfs(['pdfs/a.pdf', 'pdfs/b.pdf'], ['pdfs/a.pdf'])).toEqual(['pdfs/b.pdf']);
    expect(findOrphanPdfs(['pdfs/a.pdf'], ['pdfs\\a.pdf'])).toEqual([]);
    expect(findOrphanPdfs([], ['pdfs/a.pdf'])).toEqual([]);
  });

  it('软删文档的文件还有主，不会被当孤儿删掉', async () => {
    const d = await createDocument({ title: 'x', fileRelPath: 'pdfs/keep.pdf', fileSha256: 'k', pageCount: 1 });
    await softDeleteDocument(d.id);
    const fs = fakeFs(['pdfs/keep.pdf', 'pdfs/junk.pdf']);
    const r = await cleanupOrphanPdfs(fs);
    expect(r.removed).toEqual(['pdfs/junk.pdf']);
    expect(r.failures).toEqual([]);
  });
});

describe('启动清理', () => {
  it('清掉过期的小说与文档（连文件），保留未过期的', async () => {
    const now = Date.now();
    const oldNovel = await makeNovel('老');
    const freshNovel = await makeNovel('新');
    await deleteNovel(oldNovel.id);
    await deleteNovel(freshNovel.id);
    await getDb().execute('UPDATE novels SET deleted_at = ? WHERE id = ?', [now - TRASH_RETENTION_MS - 1, oldNovel.id]);

    const oldDoc = await createDocument({ title: '老书', fileRelPath: 'pdfs/old.pdf', fileSha256: 'o', pageCount: 1 });
    const freshDoc = await createDocument({ title: '新书', fileRelPath: 'pdfs/new.pdf', fileSha256: 'n', pageCount: 1 });
    await softDeleteDocument(oldDoc.id);
    await softDeleteDocument(freshDoc.id);
    await getDb().execute('UPDATE documents SET deleted_at = ? WHERE id = ?', [now - TRASH_RETENTION_MS - 1, oldDoc.id]);

    const fs = fakeFs(['pdfs/old.pdf', 'pdfs/new.pdf', 'pdfs/orphan.pdf']);
    const report = await runStartupMaintenance(now, fs);
    expect(report.purgedNovels).toBe(1);
    expect(report.purgedDocuments).toBe(1);
    expect(report.removedOrphans).toEqual(['pdfs/orphan.pdf']);
    expect(report.failures).toEqual([]);
    expect(fs.removed).toContain('pdfs/old.pdf');
    expect((await listTrashedNovels()).map((n) => n.id)).toEqual([freshNovel.id]);
    expect((await listTrashedDocuments()).map((d) => d.id)).toEqual([freshDoc.id]);
  });

  it('单条失败不影响其它条目，记录在 failures 里', async () => {
    const now = Date.now();
    const d = await createDocument({ title: '坏', fileRelPath: 'pdfs/bad.pdf', fileSha256: 'b', pageCount: 1 });
    await softDeleteDocument(d.id);
    await getDb().execute('UPDATE documents SET deleted_at = ? WHERE id = ?', [now - TRASH_RETENTION_MS - 1, d.id]);
    const fs = fakeFs(['pdfs/bad.pdf']);
    fs.failOn = 'pdfs/bad.pdf';
    const r = await purgeExpiredTrash(now, fs);
    expect(r.documents).toBe(0);
    expect(r.failures).toHaveLength(1);
    expect(await listTrashedDocuments()).toHaveLength(1);
  });
});

describe('书架字数聚合', () => {
  it('一次查询拿到全部小说的字数', async () => {
    const a = await makeNovel('A');
    const b = await makeNovel('B');
    const c = await makeNovel('C');
    const a1 = await upsertChapterPlan(a.id, { chapterNo: 1 });
    const a2 = await upsertChapterPlan(a.id, { chapterNo: 2 });
    const b1 = await upsertChapterPlan(b.id, { chapterNo: 1 });
    await createVersion({ chapterId: a1.id, content: '一二三', source: 'generated' });
    await createVersion({ chapterId: a2.id, content: '四五', source: 'generated' });
    await createVersion({ chapterId: b1.id, content: '六', source: 'generated' });
    const counts = await novelCharCounts();
    expect(counts[a.id]).toBe(5);
    expect(counts[b.id]).toBe(1);
    expect(counts[c.id] ?? 0).toBe(0);
    // 与逐本查询结果一致
    expect(counts[a.id]).toBe(await novelCharCount(a.id));
  });
});
