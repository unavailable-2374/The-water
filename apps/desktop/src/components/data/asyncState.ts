/**
 * 列表 / 单次请求的状态机 —— 纯函数，不碰 React，可以直接单测。
 *
 * 各列表页原来都是手写 `useState + useEffect + cursor + busy + try/catch`，
 * 一份样板抄了八遍，还各自漏掉「卸载后 setState」「翻页请求乱序」这类边角。
 * 把状态迁移收敛到这里，hook 只负责跟 React 打交道。
 */

export interface AsyncState<T> {
  /** 还没加载过是 undefined；加载失败保留上一份成功的数据。 */
  data: T | undefined;
  /** 首次加载 / 重新加载中。 */
  loading: boolean;
  /** 追加下一页中（首屏不算）。 */
  loadingMore: boolean;
  error: unknown;
  /** 下一页游标，null 表示到底了。 */
  cursor: string | null;
}

export type AsyncAction<T> =
  | { type: 'reset' }
  | { type: 'start'; append: boolean }
  | { type: 'success'; data: T; cursor?: string | null; append?: boolean; merge?: (prev: T | undefined, next: T) => T }
  | { type: 'failure'; error: unknown }
  | { type: 'set'; data: T };

export function initialAsyncState<T>(initial?: T): AsyncState<T> {
  return { data: initial, loading: false, loadingMore: false, error: null, cursor: null };
}

export function asyncReducer<T>(state: AsyncState<T>, action: AsyncAction<T>): AsyncState<T> {
  switch (action.type) {
    case 'reset':
      return initialAsyncState<T>();
    case 'start':
      // 重新加载时清掉旧错误，但保留旧数据，避免列表闪成空白。
      return { ...state, loading: !action.append, loadingMore: action.append, error: null };
    case 'success': {
      const data = action.append && action.merge ? action.merge(state.data, action.data) : action.data;
      return { data, loading: false, loadingMore: false, error: null, cursor: action.cursor ?? null };
    }
    case 'failure':
      return { ...state, loading: false, loadingMore: false, error: action.error };
    case 'set':
      return { ...state, data: action.data };
  }
}

/** 请求是否正在进行（首屏或翻页都算）。 */
export function isBusy<T>(state: AsyncState<T>): boolean {
  return state.loading || state.loadingMore;
}

/** 还有没有下一页。 */
export function hasMore<T>(state: AsyncState<T>): boolean {
  return state.cursor !== null;
}
