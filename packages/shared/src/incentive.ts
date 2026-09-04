/**
 * 激励计划：规则即数据。服务端只有一个 award() 入口按这里的规则记账；桌面端用同一份数据渲染等级、徽章。
 * 全部为纯数据/纯函数，不依赖 API schema（避免与 community.ts 循环引用）。
 */
import { z } from 'zod';

export const PointKindSchema = z.enum([
  'novel_published',
  'version_published',
  'novel_completed',
  'like_received',
  'fork_received',
  'view_received',
  'view_shared',
  'comment_posted',
  'comment_received',
  'follower_gained',
  'adjustment',
]);
export type PointKind = z.infer<typeof PointKindSchema>;

export interface DailyCap {
  /** user：每位受益人每日次数；novel：每本小说每日次数（capScopeId 指定小说）。 */
  scope: 'user' | 'novel';
  max: number;
}
export interface PointRule {
  points: number;
  dailyCap?: DailyCap;
}

/** 首版发布：原创与二创分值不同。 */
export const PUBLISH_POINTS = { original: 50, derivative: 30 } as const;
/** 浏览计分：原创 10 分全给作者；二创 7 分给二创作者（view_received）、3 分给直接来源作者（view_shared）。 */
export const DERIVATIVE_VIEW_SPLIT = { derivative: 7, source: 3 } as const;

export const POINT_RULES: Record<Exclude<PointKind, 'adjustment'>, PointRule> = {
  novel_published: { points: PUBLISH_POINTS.original },
  version_published: { points: 10 },
  novel_completed: { points: 20 },
  like_received: { points: 2 },
  fork_received: { points: 10 },
  view_received: { points: 10, dailyCap: { scope: 'novel', max: 30 } },
  view_shared: { points: DERIVATIVE_VIEW_SPLIT.source, dailyCap: { scope: 'novel', max: 30 } },
  comment_posted: { points: 1, dailyCap: { scope: 'user', max: 10 } },
  comment_received: { points: 1, dailyCap: { scope: 'novel', max: 20 } },
  follower_gained: { points: 2 },
};

export const POINT_KIND_LABELS: Record<PointKind, string> = {
  novel_published: '发布了新故事',
  version_published: '更新了故事',
  novel_completed: '写完了一个故事',
  like_received: '收到喜欢',
  fork_received: '故事被二创',
  view_received: '故事被阅读',
  view_shared: '二创被阅读，原作分成',
  comment_posted: '留下了留言',
  comment_received: '收到留言',
  follower_gained: '多了一位关注者',
  adjustment: '积分调整',
};

// ---- 等级 ----

export interface LevelDef {
  level: number;
  min: number;
  title: string;
}
export const LEVELS: readonly LevelDef[] = [
  { level: 1, min: 0, title: '初涉' },
  { level: 2, min: 100, title: '执笔' },
  { level: 3, min: 300, title: '成篇' },
  { level: 4, min: 800, title: '结集' },
  { level: 5, min: 2000, title: '名家' },
  { level: 6, min: 5000, title: '宗师' },
  { level: 7, min: 12000, title: '传世' },
];

export const LevelSchema = z.object({
  level: z.number().int(),
  title: z.string(),
  min: z.number().int(),
  /** 下一级门槛；已满级为 null。 */
  next: z.number().int().nullable(),
});
export type Level = z.infer<typeof LevelSchema>;

export function levelFor(points: number): Level {
  const p = Number.isFinite(points) ? Math.max(0, points) : 0;
  let idx = 0;
  for (let i = 0; i < LEVELS.length; i++) {
    if (p >= LEVELS[i]!.min) idx = i;
  }
  const cur = LEVELS[idx]!;
  const nxt = LEVELS[idx + 1];
  return { level: cur.level, title: cur.title, min: cur.min, next: nxt ? nxt.min : null };
}

/** 当前等级进度 0..1；满级为 1。 */
export function levelProgress(points: number): number {
  const l = levelFor(points);
  if (l.next === null) return 1;
  return Math.min(1, Math.max(0, (points - l.min) / (l.next - l.min)));
}

// ---- 徽章 ----

export const BadgeIdSchema = z.enum([
  'first_publish',
  'first_derivative',
  'forked_1',
  'forked_10',
  'likes_100',
  'followers_10',
  'followers_100',
  'level_3',
  'level_5',
  'level_7',
]);
export type BadgeId = z.infer<typeof BadgeIdSchema>;

export interface BadgeStats {
  points: number;
  /** 已公开发布的原创数 / 二创数。 */
  novelCount: number;
  derivativeCount: number;
  /** 本人作品被二创的次数（fork 记录数）。 */
  derivedCount: number;
  followerCount: number;
  likeReceived: number;
  commentReceived: number;
}

export interface BadgeDef {
  id: BadgeId;
  name: string;
  description: string;
  check: (s: BadgeStats) => boolean;
}

export const BADGES: readonly BadgeDef[] = [
  { id: 'first_publish', name: '初次登台', description: '发布了第一个故事', check: (s) => s.novelCount + s.derivativeCount >= 1 },
  { id: 'first_derivative', name: '续写者', description: '发布了第一部二创', check: (s) => s.derivativeCount >= 1 },
  { id: 'forked_1', name: '开枝散叶', description: '故事被人二创', check: (s) => s.derivedCount >= 1 },
  { id: 'forked_10', name: '枝繁叶茂', description: '故事被二创十次', check: (s) => s.derivedCount >= 10 },
  { id: 'likes_100', name: '百人喜欢', description: '累计收到一百个喜欢', check: (s) => s.likeReceived >= 100 },
  { id: 'followers_10', name: '有人等更', description: '有十位读者关注', check: (s) => s.followerCount >= 10 },
  { id: 'followers_100', name: '一呼百应', description: '有一百位读者关注', check: (s) => s.followerCount >= 100 },
  { id: 'level_3', name: '成篇', description: '达到第 3 级', check: (s) => levelFor(s.points).level >= 3 },
  { id: 'level_5', name: '名家', description: '达到第 5 级', check: (s) => levelFor(s.points).level >= 5 },
  { id: 'level_7', name: '传世', description: '达到第 7 级', check: (s) => levelFor(s.points).level >= 7 },
];

export const BADGE_BY_ID: Record<BadgeId, BadgeDef> = Object.fromEntries(BADGES.map((b) => [b.id, b])) as Record<BadgeId, BadgeDef>;

export function badgesFor(stats: BadgeStats): BadgeId[] {
  return BADGES.filter((b) => b.check(stats)).map((b) => b.id);
}

export function emptyBadgeStats(): BadgeStats {
  return { points: 0, novelCount: 0, derivativeCount: 0, derivedCount: 0, followerCount: 0, likeReceived: 0, commentReceived: 0 };
}
