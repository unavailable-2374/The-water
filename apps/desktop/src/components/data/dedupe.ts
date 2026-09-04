/**
 * 同一把钥匙上的并发请求只发一次，并且带引用计数的取消。
 *
 * 为什么不是简单地「记住 Promise」：调用方各自持有自己的 AbortController，
 * 谁先卸载就 abort 谁的。如果几个调用方共用一个底层请求，先走的那个一 abort
 * 就把还在等的人一起打断了。所以这里给共享请求单独一个 controller，
 * 只有当所有订阅者都撤了，才真的把底层请求掐掉。
 *
 * 这里刻意不做缓存：数据大多来自本地 SQLite，写操作是命令式的，
 * 需要的只是「别把同一个请求同时打两遍」，不是一层带失效策略的缓存。
 */
interface Entry {
  promise: Promise<unknown>;
  controller: AbortController;
  refs: number;
}

const inflight = new Map<string, Entry>();

export function dedupe<T>(key: string, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  let entry = inflight.get(key);
  if (entry === undefined) {
    const controller = new AbortController();
    const created: Entry = { controller, refs: 0, promise: Promise.resolve() };
    created.promise = Promise.resolve().then(() => run(controller.signal));
    // 清理挂在「已经吞掉错误」的那条链上：订阅者可能全都不 await（都卸载了），
    // 如果这里再产生一个裸的 rejected promise，就会变成「未处理的 rejection」。
    void created.promise
      .catch(() => undefined)
      .finally(() => { if (inflight.get(key) === created) inflight.delete(key); });
    inflight.set(key, created);
    entry = created;
  }
  const e = entry;
  e.refs += 1;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    e.refs -= 1;
    if (e.refs <= 0) {
      e.controller.abort();
      if (inflight.get(key) === e) inflight.delete(key);
    }
  };
  if (signal) {
    if (signal.aborted) release();
    else signal.addEventListener('abort', release, { once: true });
  }
  return (e.promise as Promise<T>).finally(() => {
    // 请求已经结束，再 abort 没有意义，把订阅摘掉即可。
    if (signal && !released) signal.removeEventListener('abort', release);
    released = true;
  });
}

/** 当前正在飞的请求数，测试用。 */
export function inflightCount(): number {
  return inflight.size;
}

/** 清空在途表，测试用。 */
export function resetInflight(): void {
  inflight.clear();
}
