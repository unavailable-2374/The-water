/**
 * 屏蔽是双向不可见 + 单向禁互动：
 * 列表用 notBlockedEitherWay() 过滤（drizzle 的 notInArray 支持子查询，无需方言 SQL），
 * 互动前用 assertNotBlocked() 拦截。此文件只依赖 db 与 schema，避免与业务模块循环引用。
 */
import { and, eq, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { AppDeps } from '../../context';
import { blocks } from '../../db/schema';
import { ApiError } from '../../lib/errors';

export function isBlockedEitherWay(deps: AppDeps, a: string, b: string): boolean {
  if (a === b) return false;
  const row = deps.db
    .select({ x: sql`1` })
    .from(blocks)
    .where(
      or(
        and(eq(blocks.blockerId, a), eq(blocks.blockedId, b)),
        and(eq(blocks.blockerId, b), eq(blocks.blockedId, a)),
      ),
    )
    .get();
  return !!row;
}

export function hasBlocked(deps: AppDeps, blockerId: string, blockedId: string): boolean {
  return !!deps.db
    .select({ x: sql`1` })
    .from(blocks)
    .where(and(eq(blocks.blockerId, blockerId), eq(blocks.blockedId, blockedId)))
    .get();
}

/** 互动入口的统一守卫：任一方向存在屏蔽即 403。 */
export function assertNotBlocked(deps: AppDeps, actorId: string, targetUserId: string): void {
  if (isBlockedEitherWay(deps, actorId, targetUserId)) {
    throw new ApiError('BLOCKED', '你们之间设置了屏蔽，暂时不能这样做');
  }
}

/** 列表条件：作者既不在"我屏蔽的人"里，也不在"屏蔽了我的人"里。 */
export function notBlockedEitherWay(deps: AppDeps, viewerId: string, authorCol: SQLiteColumn): SQL {
  const iBlocked = deps.db.select({ id: blocks.blockedId }).from(blocks).where(eq(blocks.blockerId, viewerId));
  const blockedMe = deps.db.select({ id: blocks.blockerId }).from(blocks).where(eq(blocks.blockedId, viewerId));
  return and(notInArray(authorCol, iBlocked), notInArray(authorCol, blockedMe))!;
}
