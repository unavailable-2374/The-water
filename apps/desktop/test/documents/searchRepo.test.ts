import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { getDb } from '@/db/db';
import {
  createDocument, dropSearchIndex, ensureSearchIndex, isFtsAvailable, likeEscape,
  pruneOrphanSearchIndex, resetFtsAvailability, searchPageTexts, upsertPageText,
} from '@/db/repos/documentsRepo';
import { buildSearchHits, stepHit } from '@/documents/search';

const PAGES = [
  '中华人民共和国是统一的多民族国家。',
  '宇宙洪荒，天地玄黄。The Water is a reading app.',
  '人民日报社论：宇宙很大。',
];

async function seed(): Promise<string> {
  const doc = await createDocument({ title: '测试书', fileRelPath: 'pdfs/t.pdf', fileSha256: 't', pageCount: PAGES.length });
  for (let i = 0; i < PAGES.length; i++) await upsertPageText(doc.id, i + 1, PAGES[i]!);
  return doc.id;
}

beforeEach(() => { useTestDb(); resetFtsAvailability(); });

describe('全文检索（FTS5 路径）', () => {
  it('迁移 0006 在测试库里能用', async () => {
    expect(await isFtsAvailable()).toBe(true);
  });

  it('中文双字词能命中，且只命中含它的页', async () => {
    const id = await seed();
    const r = await searchPageTexts(id, '人民');
    expect(r.engine).toBe('fts');
    expect(r.pages.map((p) => p.pageNo).sort()).toEqual([1, 3]);
  });

  it('长词、单字与西文都能命中', async () => {
    const id = await seed();
    expect((await searchPageTexts(id, '中华人民共和国')).pages.map((p) => p.pageNo)).toEqual([1]);
    expect((await searchPageTexts(id, '荒')).pages.map((p) => p.pageNo)).toEqual([2]);
    expect((await searchPageTexts(id, 'water')).pages.map((p) => p.pageNo)).toEqual([2]);
  });

  it('不存在的词返回空', async () => {
    const id = await seed();
    expect((await searchPageTexts(id, '量子纠缠')).pages).toEqual([]);
  });

  it('改一页文本后索引跟着更新', async () => {
    const id = await seed();
    await upsertPageText(id, 1, '改成了完全不同的内容：海阔天空。');
    expect((await searchPageTexts(id, '人民')).pages.map((p) => p.pageNo)).toEqual([3]);
    expect((await searchPageTexts(id, '海阔')).pages.map((p) => p.pageNo)).toEqual([1]);
  });

  it('结果超过 limit 时给出截断标记', async () => {
    const id = await seed();
    const r = await searchPageTexts(id, '人民', 1);
    expect(r.pages).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });

  it('dropSearchIndex 清掉一本书的索引', async () => {
    const id = await seed();
    await dropSearchIndex(id);
    expect((await searchPageTexts(id, '人民')).pages).toEqual([]);
  });

  it('ensureSearchIndex 回填老书（页文本先于 FTS 表存在）', async () => {
    const id = await seed();
    await dropSearchIndex(id);
    expect(await ensureSearchIndex(id)).toBe(PAGES.length);
    expect((await searchPageTexts(id, '人民')).pages.map((p) => p.pageNo)).toEqual([1, 3]);
    // 已经建好的不会重复回填
    expect(await ensureSearchIndex(id)).toBe(0);
  });

  it('pruneOrphanSearchIndex 清掉没有主人的索引行', async () => {
    const id = await seed();
    await getDb().execute('DELETE FROM documents WHERE id = ?', [id]);
    await pruneOrphanSearchIndex();
    const rows = await getDb().select<{ n: number }>('SELECT COUNT(*) AS n FROM document_pages_fts');
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe('FTS 不可用时回退 LIKE', () => {
  it('虚拟表不存在也能搜到，只是走 LIKE', async () => {
    const db = useTestDb();
    resetFtsAvailability();
    const id = await seed();
    db.raw.exec('DROP TABLE document_pages_fts');
    resetFtsAvailability();
    expect(await isFtsAvailable()).toBe(false);
    const r = await searchPageTexts(id, '人民');
    expect(r.engine).toBe('like');
    expect(r.pages.map((p) => p.pageNo).sort()).toEqual([1, 3]);
  });

  it('回退路径下写页文本不会炸', async () => {
    const db = useTestDb();
    resetFtsAvailability();
    db.raw.exec('DROP TABLE document_pages_fts');
    resetFtsAvailability();
    const id = await seed();
    expect((await searchPageTexts(id, '宇宙')).pages.map((p) => p.pageNo)).toEqual([2, 3]);
  });

  it('LIKE 通配符被转义，不会变成万能匹配', async () => {
    const db = useTestDb();
    resetFtsAvailability();
    const id = await seed();
    db.raw.exec('DROP TABLE document_pages_fts');
    resetFtsAvailability();
    expect(likeEscape('a%b_c')).toBe('a\\%b\\_c');
    expect((await searchPageTexts(id, '%')).pages).toEqual([]);
  });
});

describe('命中展开与导航', () => {
  it('按页展开成逐条命中，并统计页数', () => {
    const out = buildSearchHits([{ pageNo: 2, text: '宇宙洪荒。宇宙很大。' }, { pageNo: 5, text: '宇宙' }], '宇宙');
    expect(out.hits).toHaveLength(3);
    expect(out.pages).toBe(2);
    expect(out.hits.map((h) => [h.pageNo, h.occurrence])).toEqual([[2, 0], [2, 1], [5, 0]]);
    expect(out.truncated).toBe(false);
  });

  it('超过上限时截断', () => {
    const out = buildSearchHits([{ pageNo: 1, text: '啊啊啊啊' }], '啊', 2);
    expect(out.hits).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });

  it('上一条 / 下一条循环移动', () => {
    expect(stepHit(3, -1, 1)).toBe(0);
    expect(stepHit(3, -1, -1)).toBe(2);
    expect(stepHit(3, 2, 1)).toBe(0);
    expect(stepHit(3, 0, -1)).toBe(2);
    expect(stepHit(0, -1, 1)).toBe(-1);
  });
});
