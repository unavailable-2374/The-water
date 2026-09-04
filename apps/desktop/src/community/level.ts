import { levelFor, type Level } from '@the-water/shared';

export interface LevelView {
  level: Level;
  /** 当前等级内的进度 0..1；满级为 1。 */
  ratio: number;
  /** 距离下一级还差多少分；满级为 null。 */
  remaining: number | null;
}

/** 服务端已经算好 level 时直接传进来，避免两边算法漂移。 */
export function levelView(points: number, level: Level = levelFor(points)): LevelView {
  if (level.next === null) return { level, ratio: 1, remaining: null };
  const span = Math.max(1, level.next - level.min);
  const ratio = Math.min(1, Math.max(0, (points - level.min) / span));
  return { level, ratio, remaining: Math.max(0, level.next - points) };
}
