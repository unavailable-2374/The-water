/**
 * 通知的展示规则：图标、跳转目标、分组标签。
 * 全是纯函数，桌面 UI 没有测试框架，逻辑放这里才测得动。
 */
import type { Notification, NotificationKind } from '@the-water/shared';
import { t } from '@/i18n';

export type NotificationIconName = 'follow' | 'like' | 'comment' | 'fork' | 'badge' | 'shield';

const ICONS: Record<NotificationKind, NotificationIconName> = {
  followed: 'follow',
  liked: 'like',
  comment_liked: 'like',
  commented: 'comment',
  replied: 'comment',
  mentioned: 'comment',
  forked: 'fork',
  badge: 'badge',
  moderation_novel: 'shield',
  moderation_comment: 'shield',
};

export function notificationIcon(kind: NotificationKind): NotificationIconName {
  return ICONS[kind] ?? 'comment';
}

/** 审核类通知要显眼一点，其余按语义配色。 */
export function notificationTone(kind: NotificationKind): 'tea' | 'cinnabar' | 'ink' {
  if (kind === 'moderation_novel' || kind === 'moderation_comment') return 'cinnabar';
  if (kind === 'badge') return 'tea';
  return 'ink';
}

export type NotificationTarget = Pick<Notification, 'refType' | 'refId' | 'novelId'> & {
  actor?: { handle: string } | null;
};

/**
 * 点开一条通知去哪儿。
 * 作品 / 留言都落到作品页（留言靠 novelId），被关注落到对方主页，
 * 徽章与系统通知没有更细的落点，返回 null 表示不可点。
 */
export function notificationTarget(n: NotificationTarget): string | null {
  if (n.refType === 'novel') return `/public/${encodeURIComponent(n.refId)}`;
  if (n.refType === 'comment') return n.novelId ? `/public/${encodeURIComponent(n.novelId)}` : null;
  if (n.refType === 'user') {
    const who = n.actor?.handle || n.refId;
    return who ? `/public/u/${encodeURIComponent(who)}` : null;
  }
  return null;
}

/** 通知列表的时间分组：今天 / 昨天 / 更早。 */
export function notificationDayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return t.community.dayEarlier;
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return t.community.dayToday;
  if (days === 1) return t.community.dayYesterday;
  if (days < 7) return t.community.periodWeek;
  return t.community.dayEarlier;
}

export interface NotificationGroup {
  label: string;
  items: Notification[];
}

/** 按天分组，保持服务端给的倒序。 */
export function groupNotifications(items: Notification[], now: Date = new Date()): NotificationGroup[] {
  const out: NotificationGroup[] = [];
  for (const item of items) {
    const label = notificationDayLabel(item.createdAt, now);
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push(item);
    else out.push({ label, items: [item] });
  }
  return out;
}

/** 小红点上的数字：超过 99 就写 99+。 */
export function unreadBadgeText(n: number): string | null {
  if (n <= 0) return null;
  return n > 99 ? '99+' : String(n);
}
