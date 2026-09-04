/**
 * 唯一允许出现方言 SQL 的文件：FTS5 全文检索、LIKE 转义搜索与 JSON 数组包含判断。
 *
 * 本服务是 SQLite-only 的（理由见 README「为什么是 SQLite-only」），
 * 这里不再为「切换 PostgreSQL」保留抽象层。
 */
import { sql, type SQL } from 'drizzle-orm';
import { ftsMatchQuery, isFtsSupported } from './fts';
import { novels } from './schema';

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** LIKE 回退路径：前导通配会全表扫描，只在 FTS5 不可用或查询里没有可索引字符时用。 */
function likeContains(q: string): SQL {
  const pattern = `%${escapeLike(q)}%`;
  return sql`(${novels.title} LIKE ${pattern} ESCAPE '\\' OR ${novels.summary} LIKE ${pattern} ESCAPE '\\')`;
}

/**
 * 标题或简介包含关键词。
 *
 * 走 `novels_fts` 虚拟表：先由 FTS 得出命中的 id 集合，再回到 novels 上过滤，
 * 避免相关子查询导致「每行跑一次 FTS」。索引由 db/fts.ts 的队列维护。
 * FTS5 不可用（构建没编、或索引写失败）时自动回退 LIKE，语义一致只是慢。
 */
export function titleOrSummaryContains(q: string): SQL {
  const match = isFtsSupported() ? ftsMatchQuery(q) : null;
  if (!match) return likeContains(q);
  return sql`${novels.id} IN (SELECT novel_id FROM novels_fts WHERE novels_fts.body MATCH ${match})`;
}

/** tags JSON 数组包含指定标签。 */
export function hasTag(tag: string): SQL {
  return sql`EXISTS (SELECT 1 FROM json_each(${novels.tags}) WHERE json_each.value = ${tag})`;
}
