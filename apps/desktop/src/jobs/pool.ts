/**
 * 任务池 / 聊天池（§2.1 第 8 条）。
 *
 * 原来的 runner 是「全局严格串行单任务」：一本长篇跑着，其他小说的任务排队，
 * 阅读器聊天也跟着排——因为聊天与任务共用同一个 `RateGate`（按 providerId 建的）。
 *
 * 这里做两件事：
 *   1. 限流分池：任务侧一律使用 `providerId#task` 这个 gate id，聊天侧继续用裸的
 *      `providerId`。两条通道于是各排各的队，长篇写作不再让聊天等着。
 *      （更彻底的做法是让 `RateGate` 原生支持多池，需要改 `llm/retry.ts`，见报告。）
 *   2. 任务并发：runner 不再只跑一个任务，而是按「全局上限 + 供应商级并发数」
 *      挑出可以同时推进的任务。供应商级并发数就是迁移 0004 里加好的
 *      `llm_providers.concurrency` 列（默认 1）。
 */
import { getDb } from '@/db/db';
import { getSetting } from '@/db/repos/settingsRepo';
import { getRateGate, type RateGate } from '@/llm/retry';

/** 默认同时推进的任务数。1 = 与改造前的行为一致。 */
export const DEFAULT_MAX_CONCURRENT_JOBS = 2;
/** 供应商没配并发数时的默认值。 */
export const DEFAULT_PROVIDER_CONCURRENCY = 1;

export type PoolName = 'task' | 'chat';

export function poolGateId(providerId: string, pool: PoolName): string {
  return pool === 'chat' ? providerId : `${providerId}#${pool}`;
}

/** 任务侧的限流闸门；聊天侧走 `getRateGate(providerId)` 不变。 */
export function taskGate(providerId: string): RateGate {
  return getRateGate(poolGateId(providerId, 'task'));
}

export interface PoolLimits {
  maxJobs: number;
  /** providerId → 并发数。 */
  perProvider: Record<string, number>;
  defaultPerProvider: number;
}

export interface PoolCandidate { id: string; providerId: string | null }

const PROVIDER_ANY = '';

const limitFor = (limits: PoolLimits, providerId: string | null): number => {
  const key = providerId ?? PROVIDER_ANY;
  const v = limits.perProvider[key];
  return v != null && v > 0 ? v : limits.defaultPerProvider;
};

/**
 * 纯调度函数：给定候选任务（已按创建顺序排好）、正在跑的任务和上限，
 * 返回这一轮可以启动的任务 id。同一本小说同时只跑一个任务，避免两个任务抢同一批章节。
 */
export function planPoolStarts(candidates: readonly PoolCandidate[], active: readonly PoolCandidate[], limits: PoolLimits, novelOf?: (id: string) => string | null): string[] {
  const starts: string[] = [];
  let total = active.length;
  const perProvider = new Map<string, number>();
  for (const a of active) perProvider.set(a.providerId ?? PROVIDER_ANY, (perProvider.get(a.providerId ?? PROVIDER_ANY) ?? 0) + 1);
  const busyNovels = new Set<string>();
  if (novelOf) for (const a of active) { const n = novelOf(a.id); if (n) busyNovels.add(n); }

  for (const c of candidates) {
    if (total >= limits.maxJobs) break;
    const key = c.providerId ?? PROVIDER_ANY;
    if ((perProvider.get(key) ?? 0) >= limitFor(limits, c.providerId)) continue;
    const novel = novelOf?.(c.id) ?? null;
    if (novel && busyNovels.has(novel)) continue;
    starts.push(c.id);
    total++;
    perProvider.set(key, (perProvider.get(key) ?? 0) + 1);
    if (novel) busyNovels.add(novel);
  }
  return starts;
}

/** 从设置与 `llm_providers.concurrency` 读出当前上限。 */
export async function loadPoolLimits(): Promise<PoolLimits> {
  const raw = await getSetting<number>('maxConcurrentJobs', DEFAULT_MAX_CONCURRENT_JOBS);
  const maxJobs = Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : DEFAULT_MAX_CONCURRENT_JOBS;
  const perProvider: Record<string, number> = {};
  try {
    const rows = await getDb().select<{ id: string; concurrency: number | null }>('SELECT id, concurrency FROM llm_providers');
    for (const r of rows) if (r.concurrency != null && r.concurrency > 0) perProvider[r.id] = Math.trunc(r.concurrency);
  } catch {
    /* 迁移未跑到 0004 的旧库：按默认并发处理 */
  }
  return { maxJobs, perProvider, defaultPerProvider: DEFAULT_PROVIDER_CONCURRENCY };
}
