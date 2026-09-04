/**
 * 浏览搜索的 FTS5 索引：unicode61 分词器 + 应用层重叠 bigram 切分。
 *
 * SQLite 自带的分词器对中文都不可用：`unicode61` 把一整串汉字当成一个词，
 * `trigram` 又要求查询至少 3 个字，中文里最常见的双字词就搜不到。
 * 所以入库前先由本文件做二元切分：
 *   「中国人民」 → 「中国 国人 人民 民」
 * 查询时做同样的切分并拼成短语查询：
 *   「国人民」 → '"国人 人民"'
 * 短语查询要求这些 bigram 在文档里连续出现，等价于子串匹配，不会有二元切分常见的假命中。
 * 入库时额外补一个「末字」单字 token，保证任何单字查询都能作为某个 token 的前缀命中。
 *
 * 这套切分与桌面端阅读器 `apps/desktop/src/documents/fts.ts` 是同一套思路，
 * 两边的索引互不相干（一个索引 PDF 页文本，一个索引作品标题与简介），故各自保留一份实现。
 *
 * 同步方式：`novels` 上的触发器把变动的 id 写进 `novels_fts_pending`（见 0004 迁移），
 * 本文件的 `syncNovelsFts()` 排空队列并写虚拟表。触发器写不出 bigram，只能这样分两步。
 */
import { eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { novels, novelsFtsPending } from './schema';

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;
const WORD = /[0-9A-Za-z_À-ɏ]/;

type Run = { cjk: boolean; text: string };

/** 把文本切成「连续汉字块」与「连续西文/数字块」，其余字符（标点、空白）丢弃。 */
export function splitRuns(text: string): Run[] {
  const runs: Run[] = [];
  let cur: Run | null = null;
  for (const ch of text.normalize('NFKC')) {
    const cjk = CJK.test(ch);
    const word = !cjk && WORD.test(ch);
    if (!cjk && !word) {
      cur = null;
      continue;
    }
    if (!cur || cur.cjk !== cjk) {
      cur = { cjk, text: '' };
      runs.push(cur);
    }
    cur.text += cjk ? ch : ch.toLowerCase();
  }
  return runs;
}

/** 生成入库用的 token 串（写进 FTS 表的 body 列）。 */
export function ftsIndexText(text: string): string {
  const out: string[] = [];
  for (const run of splitRuns(text)) {
    if (!run.cjk) {
      out.push(run.text);
      continue;
    }
    const chars = [...run.text];
    if (chars.length === 1) {
      out.push(chars[0]!);
      continue;
    }
    for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
    out.push(chars[chars.length - 1]!);
  }
  return out.join(' ');
}

/** 生成 MATCH 表达式；查询里没有可用字符时返回 null（调用方据此回退 LIKE）。 */
export function ftsMatchQuery(q: string): string | null {
  const parts: string[] = [];
  for (const run of splitRuns(q)) {
    if (!run.cjk) {
      parts.push(`"${run.text}"`);
      continue;
    }
    const chars = [...run.text];
    if (chars.length === 1) {
      // 单字查询走前缀匹配：bigram token 的首字即可命中。
      parts.push(`"${chars[0]}"*`);
      continue;
    }
    const grams: string[] = [];
    for (let i = 0; i + 1 < chars.length; i++) grams.push(chars[i]! + chars[i + 1]!);
    parts.push(`"${grams.join(' ')}"`);
  }
  if (parts.length === 0) return null;
  return parts.join(' AND ');
}

// ---- 索引维护 ----

/**
 * FTS5 是否可用。这是「本进程的 SQLite 构建有没有编 FTS5」的问题，
 * 与具体是哪个库无关，所以进程内缓存一份即可。null 表示尚未探测。
 */
let ftsSupported: boolean | null = null;

export function isFtsSupported(): boolean {
  return ftsSupported === true;
}

/** 只给测试用：强制 FTS 可用状态（传 null 表示重新探测）。 */
export function setFtsSupportedForTest(v: boolean | null): void {
  ftsSupported = v;
}

const CREATE_FTS = `CREATE VIRTUAL TABLE IF NOT EXISTS novels_fts USING fts5(
  novel_id UNINDEXED,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
)`;

/**
 * 建虚拟表。构建里没有 FTS5 时不抛错，只把可用性置为 false，
 * 检索全部回退到 LIKE（见 db/search.ts）。
 */
export function ensureFtsSchema(db: Db): boolean {
  try {
    db.run(sql.raw(CREATE_FTS));
    ftsSupported = true;
  } catch (e) {
    ftsSupported = false;
    console.warn('[fts] FTS5 不可用，浏览搜索回退到 LIKE：', e instanceof Error ? e.message : e);
  }
  return ftsSupported;
}

/**
 * 队列里是否还有待建索引的作品（一次带索引的 LIMIT 1 查询，空队列时几乎免费）。
 * 队列表还不存在（0004 之前的老库）也算「没有」，不该把调用方炸掉。
 */
export function hasPendingFts(db: Db): boolean {
  if (!isFtsSupported()) return false;
  try {
    return db.select({ id: novelsFtsPending.novelId }).from(novelsFtsPending).limit(1).all().length > 0;
  } catch {
    return false;
  }
}

/**
 * 排空重建队列，返回处理的条数。
 * 作品行已经不在了（硬删）就只删索引行；否则重建 title + summary 的 token。
 */
export function syncNovelsFts(db: Db, limit = 500): number {
  if (!isFtsSupported()) return 0;
  try {
    const pending = db.select({ id: novelsFtsPending.novelId }).from(novelsFtsPending).limit(limit).all();
    if (!pending.length) return 0;
    let done = 0;
    for (const p of pending) {
      const row = db.select({ title: novels.title, summary: novels.summary }).from(novels).where(eq(novels.id, p.id)).get();
      db.run(sql`DELETE FROM novels_fts WHERE novel_id = ${p.id}`);
      if (row) {
        const body = `${ftsIndexText(row.title)} ${ftsIndexText(row.summary ?? '')}`.trim();
        db.run(sql`INSERT INTO novels_fts (novel_id, body) VALUES (${p.id}, ${body})`);
      }
      db.delete(novelsFtsPending).where(eq(novelsFtsPending.novelId, p.id)).run();
      done++;
    }
    return done;
  } catch (e) {
    // 索引写不进去不该让请求失败；标记不可用后全部走 LIKE。
    ftsSupported = false;
    console.warn('[fts] 索引重建失败，浏览搜索回退到 LIKE：', e instanceof Error ? e.message : e);
    return 0;
  }
}

/** 队列非空时才排空。搜索请求前调用，空队列的代价是一次 LIMIT 1。 */
export function syncNovelsFtsIfPending(db: Db, limit = 500): number {
  if (!hasPendingFts(db)) return 0;
  return syncNovelsFts(db, limit);
}
