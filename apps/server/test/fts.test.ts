/**
 * §4.5：浏览搜索上 FTS5（中文 bigram 切分），FTS 不可用时回退 LIKE。
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { ftsIndexText, ftsMatchQuery, isFtsSupported, setFtsSupportedForTest, syncNovelsFts } from '../src/db/fts';
import { novelsFtsPending } from '../src/db/schema';
import { titleOrSummaryContains } from '../src/db/search';
import { createNovel, makeChapters, makeTestApp, publish, type TestApp } from './helpers';

afterEach(() => {
  // 可用性是模块级状态，用例之间必须还原，否则会污染 browse 等其它文件。
  setFtsSupportedForTest(true);
});

describe('FTS 切分', () => {
  it('入库文本做重叠 bigram 切分并补末字', () => {
    expect(ftsIndexText('中国人民')).toBe('中国 国人 人民 民');
    expect(ftsIndexText('灯')).toBe('灯');
    // 标点被丢弃，两侧各自成块，不会跨标点造出假 bigram。
    expect(ftsIndexText('山，河')).toBe('山 河');
    // 西文与数字整块入库并转小写。
    expect(ftsIndexText('The Water 2026')).toBe('the water 2026');
  });

  it('查询拼成短语查询，等价子串匹配', () => {
    expect(ftsMatchQuery('国人民')).toBe('"国人 人民"');
    // 单字走前缀匹配，才能命中 bigram token 的首字。
    expect(ftsMatchQuery('灯')).toBe('"灯"*');
    expect(ftsMatchQuery('灯 water')).toBe('"灯"* AND "water"');
    // 没有可索引字符时返回 null，调用方据此回退 LIKE。
    expect(ftsMatchQuery('%')).toBeNull();
    expect(ftsMatchQuery('  ')).toBeNull();
  });
});

describe('FTS 检索', () => {
  const seed = async (t: TestApp, token: string, items: { title: string; summary: string }[]) => {
    const ids: string[] = [];
    for (const it of items) {
      const n = await createNovel(t, token, { title: it.title, summary: it.summary });
      await publish(t, token, n.id, await makeChapters(1, ids.length + 1, 100));
      ids.push(n.id);
    }
    return ids;
  };

  it('中文双字词能搜到（unicode61 / trigram 都做不到的那一档）', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const [a, b] = await seed(t, token, [
      { title: '灯下长街', summary: '雪夜守灯人的故事。' },
      { title: '流水故人', summary: '一封旧信寄往远方。' },
    ]);
    expect(isFtsSupported()).toBe(true);

    // 两个字：trigram 分词器直接搜不到的那一类。
    expect((await t.json('GET', '/api/v1/novels?q=长街')).body.items.map((n: any) => n.id)).toEqual([a!]);
    // 词中间截一段：证明是子串匹配而不是整词匹配。
    expect((await t.json('GET', '/api/v1/novels?q=下长')).body.items.map((n: any) => n.id)).toEqual([a!]);
    // 简介里的词同样能搜到。
    expect((await t.json('GET', '/api/v1/novels?q=旧信')).body.items.map((n: any) => n.id)).toEqual([b!]);
    // 单字走前缀匹配。
    expect((await t.json('GET', '/api/v1/novels?q=灯')).body.items.map((n: any) => n.id)).toEqual([a!]);
    // 不存在的词不该有命中。
    expect((await t.json('GET', '/api/v1/novels?q=飞船')).body.items.length).toBe(0);
  });

  it('bigram 的假命中被短语查询挡住', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    await seed(t, token, [{ title: '山河故人', summary: '无。' }]);
    // 「山河」「河故」「故人」都在索引里，但「河人」这个 bigram 序列并不连续出现。
    expect((await t.json('GET', '/api/v1/novels?q=山河')).body.items.length).toBe(1);
    expect((await t.json('GET', '/api/v1/novels?q=河人')).body.items.length).toBe(0);
  });

  it('改标题后索引自动跟上（触发器 → 队列 → 搜索前排空）', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const [id] = await seed(t, token, [{ title: '旧标题', summary: '旧简介。' }]);
    expect((await t.json('GET', '/api/v1/novels?q=旧标题')).body.items.length).toBe(1);

    await t.json('PATCH', `/api/v1/novels/${id}`, { token, body: { title: '新标题', summary: '新简介。' } });
    // 触发器把 id 排进了重建队列。
    expect(t.deps.db.select().from(novelsFtsPending).all().length).toBe(1);
    expect((await t.json('GET', '/api/v1/novels?q=新标题')).body.items.length).toBe(1);
    // 排空之后队列清空，旧标题不再命中。
    expect(t.deps.db.select().from(novelsFtsPending).all().length).toBe(0);
    expect((await t.json('GET', '/api/v1/novels?q=旧标题')).body.items.length).toBe(0);
  });

  it('作品被硬删时索引行跟着删（虚拟表没有外键级联）', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const [id] = await seed(t, token, [{ title: '待删作品', summary: '无。' }]);
    t.deps.db.run(sql`DELETE FROM novels WHERE id = ${id}`);
    syncNovelsFts(t.deps.db);
    const rows = t.deps.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM novels_fts WHERE novel_id = ${id}`);
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('FTS 不可用时回退 LIKE，结果一致', async () => {
    const t = makeTestApp();
    const { token } = await t.register('a@example.com');
    const [a] = await seed(t, token, [
      { title: '灯下长街', summary: '雪夜守灯人的故事。' },
      { title: '流水故人', summary: '一封旧信寄往远方。' },
    ]);

    setFtsSupportedForTest(false);
    expect(titleOrSummaryContains('长街').queryChunks.some((c) => String(c).includes('novels_fts'))).toBe(false);
    expect((await t.json('GET', '/api/v1/novels?q=长街')).body.items.map((n: any) => n.id)).toEqual([a!]);
    expect((await t.json('GET', '/api/v1/novels?q=飞船')).body.items.length).toBe(0);
    // LIKE 通配符仍然被转义。
    expect((await t.json('GET', '/api/v1/novels?q=%25')).body.items.length).toBe(0);
  });

  it('查询里没有可索引字符时也走 LIKE（FTS 可用也一样）', () => {
    setFtsSupportedForTest(true);
    const chunks = titleOrSummaryContains('%').queryChunks.map((c) => String(c)).join(' ');
    expect(chunks).not.toContain('novels_fts');
  });
});
