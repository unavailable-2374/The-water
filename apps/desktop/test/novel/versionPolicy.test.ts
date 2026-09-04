import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEEP_VERSIONS, SESSION_IDLE_MS, isRewritePending, planRewriteResolution, selectVersionsToPrune,
  shouldSealSession, stateForNewVersion, versionLock, type PrunableVersion, type RewriteSessionView,
} from '@/novel/versionPolicy';

const session = (over: Partial<RewriteSessionView> = {}): RewriteSessionView => ({
  baselineVersionId: 'v1', baselineStatus: 'final', currentVersionId: 'v3', status: 'draft', ...over,
});
const v = (over: Partial<PrunableVersion> & { id: string; versionNo: number }): PrunableVersion => ({
  state: 'accepted', pinned: false, sessionId: null, ...over,
});

describe('待采纳状态机', () => {
  it('会话开着的时候产出的版本一律先落待采纳', () => {
    expect(stateForNewVersion({ baselineVersionId: 'v1' })).toBe('pending');
    expect(stateForNewVersion({ baselineVersionId: null })).toBe('accepted');
    expect(isRewritePending(session())).toBe(true);
    expect(isRewritePending(session({ baselineVersionId: null }))).toBe(false);
  });
  it('采纳：产出留下，当前版本与状态都不动', () => {
    expect(planRewriteResolution(session(), 'accept')).toEqual({ pendingBecomes: 'accepted', currentVersionId: 'v3', status: 'draft' });
  });
  it('丢弃：产出标为已丢弃，章节回到改写前的那一版和那个状态', () => {
    expect(planRewriteResolution(session(), 'discard')).toEqual({ pendingBecomes: 'discarded', currentVersionId: 'v1', status: 'final' });
  });
  it('丢弃时没有基线就原地不动（防止把章节清空）', () => {
    const s = session({ baselineVersionId: null, baselineStatus: null });
    expect(planRewriteResolution(s, 'discard')).toEqual({ pendingBecomes: 'discarded', currentVersionId: 'v3', status: 'draft' });
  });
  it('采纳 → 丢弃不可逆：会话关掉后再算一次仍是幂等的', () => {
    const after = planRewriteResolution(session(), 'accept');
    const closed = session({ baselineVersionId: null, baselineStatus: null, currentVersionId: after.currentVersionId, status: after.status });
    expect(planRewriteResolution(closed, 'accept')).toEqual({ pendingBecomes: 'accepted', currentVersionId: 'v3', status: 'draft' });
  });
});

describe('版本保留策略', () => {
  const many = Array.from({ length: 15 }, (_, i) => v({ id: `v${i + 1}`, versionNo: i + 1 }));
  it('保留最近 N 稿，更旧的清掉', () => {
    const ids = selectVersionsToPrune({ versions: many, keep: 3, currentVersionId: 'v15' });
    expect(ids).toEqual(['v12', 'v11', 'v10', 'v9', 'v8', 'v7', 'v6', 'v5', 'v4', 'v3', 'v2', 'v1']);
  });
  it('钉住的、当前的、待采纳的、编辑中的、改写基线都不清理', () => {
    const versions = [
      v({ id: 'cur', versionNo: 9 }),
      v({ id: 'pend', versionNo: 8, state: 'pending' }),
      v({ id: 'pin', versionNo: 3, pinned: true }),
      v({ id: 'open', versionNo: 2, sessionId: 's1' }),
      v({ id: 'base', versionNo: 1 }),
      v({ id: 'plain', versionNo: 4 }),
      v({ id: 'gone', versionNo: 5, state: 'discarded' }),
    ];
    const ids = selectVersionsToPrune({ versions, keep: 1, currentVersionId: 'cur', baselineVersionId: 'base' });
    expect(ids.sort()).toEqual(['gone', 'plain']);
  });
  it('keep 大于总数时什么都不删；keep 为 0 时也只删没锁的', () => {
    expect(selectVersionsToPrune({ versions: many, keep: 100, currentVersionId: null })).toEqual([]);
    expect(selectVersionsToPrune({ versions: many, keep: 0, currentVersionId: 'v15' })).toHaveLength(14);
  });
  it('默认保留 10 稿', () => {
    expect(selectVersionsToPrune({ versions: many, currentVersionId: 'v15' })).toHaveLength(5);
    expect(DEFAULT_KEEP_VERSIONS).toBe(10);
  });
  it('不能删的时候给出人话理由', () => {
    const ctx = { currentVersionId: 'cur', baselineVersionId: 'base' };
    expect(versionLock(v({ id: 'cur', versionNo: 1 }), ctx)).toBe('这是当前正文，不能删');
    expect(versionLock(v({ id: 'x', versionNo: 1, pinned: true }), ctx)).toBe('这一稿钉住了，先取消钉住');
    expect(versionLock(v({ id: 'x', versionNo: 1, state: 'pending' }), ctx)).toBe('这一稿还没决定采纳还是丢弃');
    expect(versionLock(v({ id: 'x', versionNo: 1, sessionId: 's' }), ctx)).toBe('这一稿正在编辑中');
    expect(versionLock(v({ id: 'base', versionNo: 1 }), ctx)).toBe('这是改写前的存档，撤销改写要用');
    expect(versionLock(v({ id: 'x', versionNo: 1 }), ctx)).toBeNull();
  });
});

describe('会话封版判定', () => {
  it('离开章节立刻封版', () => {
    expect(shouldSealSession({ lastEditAt: 1000, now: 1001, left: true })).toBe(true);
  });
  it('满 5 分钟无操作才封版', () => {
    expect(shouldSealSession({ lastEditAt: 0, now: SESSION_IDLE_MS - 1 })).toBe(false);
    expect(shouldSealSession({ lastEditAt: 0, now: SESSION_IDLE_MS })).toBe(true);
  });
  it('空闲阈值可以调（测试用）', () => {
    expect(shouldSealSession({ lastEditAt: 0, now: 50, idleMs: 100 })).toBe(false);
    expect(shouldSealSession({ lastEditAt: 0, now: 100, idleMs: 100 })).toBe(true);
  });
});
