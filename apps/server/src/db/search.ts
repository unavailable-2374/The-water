/**
 * 唯一允许出现方言 SQL 的文件：LIKE 转义搜索与 JSON 数组包含判断。
 * 切换 PostgreSQL 时仅需改此文件（ILIKE / jsonb ? 操作符）。
 */
import { sql, type SQL } from 'drizzle-orm';
import { novels } from './schema';

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 标题或简介包含关键词（大小写不敏感，仅对 ASCII 有效；中文按原样匹配）。 */
export function titleOrSummaryContains(q: string): SQL {
  const pattern = `%${escapeLike(q)}%`;
  return sql`(${novels.title} LIKE ${pattern} ESCAPE '\\' OR ${novels.summary} LIKE ${pattern} ESCAPE '\\')`;
}

/** tags JSON 数组包含指定标签。 */
export function hasTag(tag: string): SQL {
  return sql`EXISTS (SELECT 1 FROM json_each(${novels.tags}) WHERE json_each.value = ${tag})`;
}
