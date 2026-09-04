/**
 * 版本状态机与保留策略（§2.2 第 1、2、3 条）。纯函数，不碰数据库。
 *
 * 三件事在这里定，`db/repos/chaptersRepo.ts` 只负责按结论写 SQL：
 *
 * 1. **待采纳状态机**。改写任务开工前给章节开一个「改写会话」，记下改写前的
 *    版本与章节状态；会话开着的时候产出的每一版都是 pending。作者逐章采纳
 *    （pending → accepted，当前版本不动）或丢弃（pending → discarded，
 *    章节回到 baseline，状态也回到改写前）。
 *    注意 pending 版本**照旧是 current**：adjust_length / style_check /
 *    summarize 都读 chapters.current_version_id，不置 current 后面几步就会
 *    拿着旧正文干活。pending 表达的是「作者还没点头」，不是「还没生效」。
 * 2. **保留策略**。保留最近 N 稿，外加钉住的、当前的、待采纳的、正在编辑会话
 *    里的、以及开着的会话的基线——这些一律不清理。
 * 3. **会话封版判定**。离开章节，或者 5 分钟没动静，就把这一次编辑会话封版。
 */
import type { ChapterStatus } from '@/db/repos/chaptersRepo';

export type VersionState = 'accepted' | 'pending' | 'discarded';

// ---------------------------------------------------------------------------
// 1. 待采纳状态机
// ---------------------------------------------------------------------------

/** 一章「正开着的改写会话」的快照视图。 */
export interface RewriteSessionView {
  /** 改写前的版本 id；null 表示没有开着的会话。 */
  baselineVersionId: string | null;
  /** 改写前的章节状态；恢复时用。 */
  baselineStatus: ChapterStatus | null;
  /** 章节当前的版本 id。 */
  currentVersionId: string | null;
  /** 章节当前的状态。 */
  status: ChapterStatus;
}

export const isRewritePending = (s: RewriteSessionView): boolean => s.baselineVersionId !== null;

/** 会话开着的时候，新版本一律先落「待采纳」。 */
export const stateForNewVersion = (s: Pick<RewriteSessionView, 'baselineVersionId'>): VersionState =>
  s.baselineVersionId ? 'pending' : 'accepted';

export type RewriteAction = 'accept' | 'discard';

export interface RewriteResolution {
  /** 这一章所有 pending 版本要落到的状态。 */
  pendingBecomes: VersionState;
  /** 处理完之后章节的当前版本。 */
  currentVersionId: string | null;
  /** 处理完之后章节的状态。 */
  status: ChapterStatus;
}

/**
 * 采纳 / 丢弃一章的改写结果。
 * 采纳：改写产出留下、当前版本不动；丢弃：产出全部标为 discarded，
 * 章节回到改写前的那一版与那个状态（这就是「撤销这次改写」）。
 */
export function planRewriteResolution(s: RewriteSessionView, action: RewriteAction): RewriteResolution {
  if (action === 'accept') return { pendingBecomes: 'accepted', currentVersionId: s.currentVersionId, status: s.status };
  return {
    pendingBecomes: 'discarded',
    currentVersionId: s.baselineVersionId ?? s.currentVersionId,
    // 改写把状态推成了 draft/generating，撤销就要把定稿标记也还回去。
    status: s.baselineStatus ?? s.status,
  };
}

// ---------------------------------------------------------------------------
// 2. 版本保留策略
// ---------------------------------------------------------------------------

/** 默认保留最近多少稿。 */
export const DEFAULT_KEEP_VERSIONS = 10;

export interface PrunableVersion {
  id: string;
  versionNo: number;
  state: VersionState;
  pinned: boolean;
  /** 非空表示这一版还在一次编辑会话里。 */
  sessionId: string | null;
}

export interface PruneInput {
  /** 这一章的全部版本，顺序不限。 */
  versions: readonly PrunableVersion[];
  /** 保留最近多少稿。 */
  keep?: number;
  currentVersionId: string | null;
  /** 开着的改写会话的基线版本，撤销要用，绝不能清掉。 */
  baselineVersionId?: string | null;
}

/** 这一版能不能删；不能删时给出人话理由。 */
export function versionLock(v: PrunableVersion, ctx: Pick<PruneInput, 'currentVersionId' | 'baselineVersionId'>): string | null {
  if (v.id === ctx.currentVersionId) return '这是当前正文，不能删';
  if (v.pinned) return '这一稿钉住了，先取消钉住';
  if (v.state === 'pending') return '这一稿还没决定采纳还是丢弃';
  if (v.sessionId) return '这一稿正在编辑中';
  if (ctx.baselineVersionId && v.id === ctx.baselineVersionId) return '这是改写前的存档，撤销改写要用';
  return null;
}

/** 按「保留最近 N 稿 + 钉住的不动」挑出可以清理的版本 id（新到旧）。 */
export function selectVersionsToPrune(input: PruneInput): string[] {
  const keep = Math.max(0, input.keep ?? DEFAULT_KEEP_VERSIONS);
  const sorted = [...input.versions].sort((a, b) => b.versionNo - a.versionNo);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const v = sorted[i]!;
    if (i < keep) continue;
    if (versionLock(v, input)) continue;
    out.push(v.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. 会话级自动保存
// ---------------------------------------------------------------------------

/** 停手多久就把这次编辑会话封版。 */
export const SESSION_IDLE_MS = 5 * 60 * 1000;
/** 输入停下多久落一次盘（只更新会话里的那一行，不新建版本）。 */
export const AUTOSAVE_DEBOUNCE_MS = 2000;

export interface SealInput {
  /** 最后一次编辑的时间戳。 */
  lastEditAt: number;
  now: number;
  /** 作者离开了这一章（切章 / 关页面）。 */
  left?: boolean;
  /** 空闲多久算封版，默认 SESSION_IDLE_MS。 */
  idleMs?: number;
}

/** 离开章节或者 5 分钟无操作就封版。 */
export function shouldSealSession(input: SealInput): boolean {
  if (input.left) return true;
  return input.now - input.lastEditAt >= (input.idleMs ?? SESSION_IDLE_MS);
}
