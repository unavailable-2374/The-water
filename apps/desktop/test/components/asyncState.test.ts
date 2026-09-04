import { describe, expect, it } from 'vitest';
import { asyncReducer, hasMore, initialAsyncState, isBusy } from '@/components/data/asyncState';

const append = <T>(prev: T[] | undefined, next: T[]): T[] => [...(prev ?? []), ...next];

describe('asyncReducer', () => {
  it('初始状态什么都没有', () => {
    const s = initialAsyncState<number[]>();
    expect(s).toEqual({ data: undefined, loading: false, loadingMore: false, error: null, cursor: null });
    expect(isBusy(s)).toBe(false);
    expect(hasMore(s)).toBe(false);
  });

  it('首屏加载置 loading，翻页置 loadingMore', () => {
    const s0 = initialAsyncState<number[]>();
    expect(asyncReducer(s0, { type: 'start', append: false })).toMatchObject({ loading: true, loadingMore: false });
    expect(asyncReducer(s0, { type: 'start', append: true })).toMatchObject({ loading: false, loadingMore: true });
  });

  it('重新加载时清错误但保留旧数据，列表不会闪成空白', () => {
    let s = initialAsyncState<number[]>();
    s = asyncReducer(s, { type: 'success', data: [1, 2], cursor: 'c1' });
    s = asyncReducer(s, { type: 'failure', error: new Error('断网') });
    expect(s.data).toEqual([1, 2]);
    s = asyncReducer(s, { type: 'start', append: false });
    expect(s.error).toBeNull();
    expect(s.data).toEqual([1, 2]);
  });

  it('翻页把新数据接在后面，首屏则整体替换', () => {
    let s = initialAsyncState<number[]>();
    s = asyncReducer(s, { type: 'success', data: [1, 2], cursor: 'c1' });
    s = asyncReducer(s, { type: 'success', data: [3, 4], cursor: 'c2', append: true, merge: append });
    expect(s.data).toEqual([1, 2, 3, 4]);
    expect(s.cursor).toBe('c2');
    s = asyncReducer(s, { type: 'success', data: [9], cursor: null });
    expect(s.data).toEqual([9]);
    expect(hasMore(s)).toBe(false);
  });

  it('成功后 busy 全部落下', () => {
    let s = asyncReducer(initialAsyncState<number[]>(), { type: 'start', append: false });
    s = asyncReducer(s, { type: 'success', data: [1] });
    expect(isBusy(s)).toBe(false);
  });

  it('失败后 busy 也要落下，否则转圈停不下来', () => {
    let s = asyncReducer(initialAsyncState<number[]>(), { type: 'start', append: true });
    s = asyncReducer(s, { type: 'failure', error: 'x' });
    expect(isBusy(s)).toBe(false);
    expect(s.error).toBe('x');
  });

  it('cursor 为 null 表示到底了', () => {
    const s = asyncReducer(initialAsyncState<number[]>(), { type: 'success', data: [1], cursor: 'next' });
    expect(hasMore(s)).toBe(true);
    expect(hasMore(asyncReducer(s, { type: 'success', data: [1], cursor: null }))).toBe(false);
  });

  it('set 只改数据，不动加载状态（乐观更新用）', () => {
    let s = asyncReducer(initialAsyncState<number[]>(), { type: 'success', data: [1, 2], cursor: 'c' });
    s = asyncReducer(s, { type: 'set', data: [1] });
    expect(s.data).toEqual([1]);
    expect(s.cursor).toBe('c');
  });

  it('reset 回到初始状态', () => {
    let s = asyncReducer(initialAsyncState<number[]>(), { type: 'success', data: [1], cursor: 'c' });
    s = asyncReducer(s, { type: 'reset' });
    expect(s).toEqual(initialAsyncState<number[]>());
  });
});
