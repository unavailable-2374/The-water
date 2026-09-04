/**
 * 轻量数据层：列表页与详情页共用的取数 hook。
 *
 * 为什么不上 TanStack Query：本应用的数据九成来自本地 SQLite，写操作全是命令式的
 * （建任务、删小说、发留言），真正缺的只有四件事 —— 卸载后不再 setState、
 * 翻页请求乱序丢弃、同一请求并发去重、错误分支不用每页再抄一遍。
 * 这四件事一共不到一百行，换一个 40KB 的依赖 + 全局 Provider + 缓存失效纪律并不划算。
 * 需要跨页共享缓存时再谈引入。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { asyncReducer, hasMore, initialAsyncState, isBusy, type AsyncState } from './asyncState';
import { dedupe } from './dedupe';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

interface CommonOptions {
  /**
   * 这份数据的身份。它一变就重新加载，同时用作并发去重的钥匙，
   * 所以要把所有影响结果的参数都拼进去（`JSON.stringify(query)` 就够）。
   */
  key: string;
  /** 为 false 时不发请求（例如还没登录）。 */
  enabled?: boolean;
}

export interface AsyncResult<T> {
  data: T | undefined;
  loading: boolean;
  error: unknown;
  reload: () => void;
  /** 本地乐观更新，不触发请求。 */
  setData: (updater: (prev: T | undefined) => T) => void;
}

/** 取一份数据；`key` 变了或调用 `reload()` 时重取。 */
export function useAsyncData<T>(fetcher: (signal: AbortSignal) => Promise<T>, options: CommonOptions): AsyncResult<T> {
  const { key, enabled = true } = options;
  const [state, dispatch] = useReducer(asyncReducer<T>, undefined, () => initialAsyncState<T>());
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  // 每次加载自增；只有最后一次发起的请求有资格写状态。
  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    const runId = ++runIdRef.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    dispatch({ type: 'start', append: false });
    try {
      const data = await dedupe(`async:${key}`, (shared) => fetcherRef.current(shared), ac.signal);
      if (runId !== runIdRef.current || ac.signal.aborted) return;
      dispatch({ type: 'success', data });
    } catch (e) {
      if (runId !== runIdRef.current || ac.signal.aborted) return;
      dispatch({ type: 'failure', error: e });
    }
  }, [key]);

  useEffect(() => {
    if (!enabled) { dispatch({ type: 'reset' }); return; }
    void run();
    // 卸载 / key 变化时把上一发请求掐掉，回来的结果也会被 runId 挡住。
    return () => { abortRef.current?.abort(); runIdRef.current++; };
  }, [run, enabled]);

  const stateRef = useRef<AsyncState<T>>(state);
  stateRef.current = state;
  const setData = useCallback((updater: (prev: T | undefined) => T) => {
    dispatch({ type: 'set', data: updater(stateRef.current.data) });
  }, []);

  return { data: state.data, loading: state.loading, error: state.error, reload: () => void run(), setData };
}

export interface PagedResult<T> {
  items: T[];
  /** 首屏还没回来（此时应该显示骨架 / 转圈，而不是空状态）。 */
  initializing: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: unknown;
  hasMore: boolean;
  reload: () => void;
  loadMore: () => void;
  setItems: (updater: (prev: T[]) => T[]) => void;
}

/**
 * 游标分页列表。
 * `fetchPage` 拿到 `cursor` 为 null 表示取第一页；返回的 `nextCursor` 为 null 表示到底了。
 */
export function usePagedList<T>(
  fetchPage: (args: { cursor: string | null; signal: AbortSignal }) => Promise<Page<T>>,
  options: CommonOptions,
): PagedResult<T> {
  const { key, enabled = true } = options;
  const [state, dispatch] = useReducer(asyncReducer<T[]>, undefined, () => initialAsyncState<T[]>());
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const stateRef = useRef<AsyncState<T[]>>(state);
  stateRef.current = state;

  const load = useCallback(async (append: boolean) => {
    const cursor = append ? stateRef.current.cursor : null;
    // 已经到底了还点「再看一些」就直接忽略。
    if (append && cursor === null) return;
    const runId = ++runIdRef.current;
    if (!append) abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    dispatch({ type: 'start', append });
    try {
      const page = await dedupe(`paged:${key}:${cursor ?? ''}`, (shared) => fetchRef.current({ cursor, signal: shared }), ac.signal);
      if (runId !== runIdRef.current || ac.signal.aborted) return;
      dispatch({
        type: 'success', data: page.items, cursor: page.nextCursor, append,
        merge: (prev, next) => [...(prev ?? []), ...next],
      });
    } catch (e) {
      if (runId !== runIdRef.current || ac.signal.aborted) return;
      dispatch({ type: 'failure', error: e });
    }
  }, [key]);

  useEffect(() => {
    if (!enabled) { dispatch({ type: 'reset' }); return; }
    dispatch({ type: 'reset' });
    void load(false);
    return () => { abortRef.current?.abort(); runIdRef.current++; };
  }, [load, enabled]);

  const setItems = useCallback((updater: (prev: T[]) => T[]) => {
    dispatch({ type: 'set', data: updater(stateRef.current.data ?? []) });
  }, []);

  const items = useMemo(() => state.data ?? [], [state.data]);
  return {
    items,
    initializing: state.data === undefined && state.error === null,
    loading: state.loading,
    loadingMore: state.loadingMore,
    error: state.error,
    hasMore: hasMore(state),
    reload: () => void load(false),
    loadMore: () => void load(true),
    setItems,
  };
}

export { isBusy };
