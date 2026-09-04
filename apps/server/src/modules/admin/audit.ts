/**
 * 审核审计日志：每一次审核动作（人工的与自动的）都在 moderation_events 里留一条记录。
 *
 * action 取值表：
 * | action            | targetType | actorId  | 含义                             |
 * |-------------------|------------|----------|----------------------------------|
 * | auto_reject       | novel/comment/user | null | 自动审核拦截了一次写入      |
 * | novel_hide        | novel      | 管理员   | 作品置为“审核中”（hidden）        |
 * | novel_remove      | novel      | 管理员   | 作品下架（removed）               |
 * | novel_restore     | novel      | 管理员   | 作品恢复（ok）                    |
 * | comment_hide      | comment    | 管理员   | 隐藏一条留言                      |
 * | comment_restore   | comment    | 管理员   | 恢复一条留言                      |
 * | report_resolve    | report     | 管理员   | 举报处理完毕                      |
 * | report_dismiss    | report     | 管理员   | 举报被驳回                        |
 * | user_ban          | user       | 管理员   | 永久封禁账号                      |
 * | user_suspend      | user       | 管理员   | 限期禁言账号                      |
 * | user_unban        | user       | 管理员   | 解除封禁 / 禁言                   |
 * | user_auto_unban   | user       | null     | 禁言到期后系统自动恢复            |
 */
import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import type { ModerationEvent, Page } from '@the-water/shared';
import type { AppDeps } from '../../context';
import { moderationEvents, type ModerationEventRow } from '../../db/schema';
import { decodeCursor, encodeCursor } from '../../lib/cursor';
import { ApiError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import type { ModerationField } from '../../lib/moderation';
import { iso } from '../../lib/time';

export type ModerationTargetType = 'novel' | 'version' | 'comment' | 'user' | 'report';

export type ModerationAction =
  | 'auto_reject'
  | 'novel_hide'
  | 'novel_remove'
  | 'novel_restore'
  | 'comment_hide'
  | 'comment_restore'
  | 'report_resolve'
  | 'report_dismiss'
  | 'user_ban'
  | 'user_suspend'
  | 'user_unban'
  | 'user_auto_unban';

/** 事务里也能写日志，所以只依赖 drizzle 的四个方法。 */
type Executor = Pick<AppDeps['db'], 'select' | 'insert' | 'update' | 'delete'>;

export interface ModerationEventInput {
  /** null 表示系统自动动作。 */
  actorId: string | null;
  targetType: ModerationTargetType;
  targetId: string;
  action: ModerationAction;
  reason?: string | null;
  note?: string | null;
  meta?: Record<string, unknown> | null;
}

export function toModerationEvent(r: ModerationEventRow): ModerationEvent {
  return {
    id: r.id,
    actorId: r.actorId,
    targetType: r.targetType,
    targetId: r.targetId,
    action: r.action,
    reason: r.reason,
    note: r.note,
    createdAt: iso(r.createdAt),
  };
}

/** 记一条审计日志。传入 ex 可以让它和业务写入落在同一个事务里。 */
export function recordModerationEvent(deps: AppDeps, input: ModerationEventInput, ex: Executor = deps.db): void {
  ex.insert(moderationEvents)
    .values({
      id: newId(),
      actorId: input.actorId,
      targetType: input.targetType,
      targetId: input.targetId,
      action: input.action,
      reason: input.reason ?? null,
      note: input.note ?? null,
      meta: input.meta ?? null,
      createdAt: deps.clock.now(),
    })
    .run();
}

export interface ModerationEventFilter {
  targetType?: ModerationTargetType;
  targetId?: string;
  actorId?: string;
  action?: string;
}

/** 审计日志分页：按时间倒序，游标与其它列表一致。 */
export function listModerationEvents(
  deps: AppDeps,
  filter: ModerationEventFilter,
  cursorRaw: string | undefined,
  limit: number,
): Page<ModerationEvent> {
  const conds: SQL[] = [];
  if (filter.targetType) conds.push(eq(moderationEvents.targetType, filter.targetType));
  if (filter.targetId) conds.push(eq(moderationEvents.targetId, filter.targetId));
  if (filter.actorId) conds.push(eq(moderationEvents.actorId, filter.actorId));
  if (filter.action) conds.push(eq(moderationEvents.action, filter.action));
  const cursor = decodeCursor(cursorRaw);
  if (cursor) {
    conds.push(
      or(
        lt(moderationEvents.createdAt, new Date(cursor.v)),
        and(eq(moderationEvents.createdAt, new Date(cursor.v)), lt(moderationEvents.id, cursor.id)),
      )!,
    );
  }
  const rows = deps.db
    .select()
    .from(moderationEvents)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(moderationEvents.createdAt), desc(moderationEvents.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toModerationEvent),
    nextCursor: rows.length > limit && last ? encodeCursor({ v: last.createdAt.getTime(), id: last.id }) : null,
  };
}

export interface ModerationTarget {
  type: ModerationTargetType;
  id: string;
  /** 附加说明写进 meta，便于区分同一对象上的不同入口（如 comment / profile）。 */
  meta?: Record<string, unknown>;
}

/**
 * 任意短文本的准入检查。未过审即 CONTENT_REJECTED，并留下一条 auto_reject 审计记录。
 * 作品正文走 versions/service.ts 的整本审核（命中转 hidden 进人工复审），这里是写入前直接拒绝。
 */
export async function assertTextAllowed(deps: AppDeps, fields: ModerationField[], target: ModerationTarget): Promise<void> {
  const present = fields.filter((f) => f.text.trim().length > 0);
  if (!present.length) return;
  const result = await deps.moderator.checkText(present);
  if (result.ok) return;
  recordModerationEvent(deps, {
    actorId: null,
    targetType: target.type,
    targetId: target.id,
    action: 'auto_reject',
    reason: result.reason,
    meta: { ...target.meta, fields: present.map((f) => f.label) },
  });
  throw new ApiError('CONTENT_REJECTED', `内容未通过审核：${result.reason}`);
}
