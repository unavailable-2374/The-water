import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useJobs } from '@/stores/jobsStore';

/**
 * While a generation job is running, closing the window hides it instead (the job keeps going; reopen from the Dock).
 *
 * 注意：一旦注册了 onCloseRequested，关窗就走 JS 这条路——Tauri 在 handler 返回后若没被 preventDefault
 * 就会调 `window.destroy()`（需要 `core:window:allow-destroy` 权限）。所以 handler 里任何异常都必须自己吞掉，
 * 否则监听器的 promise 会 reject 成未处理错误，窗口也关不掉。
 */
export function useCloseToDock(): void {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    getCurrentWindow()
      .onCloseRequested(async (e) => {
        try {
          const active = Object.values(useJobs.getState().jobs).some((j) => j.status === 'running' || j.status === 'pausing');
          if (!active) return;
          // 先真的藏起来，成功了才拦截关闭；hide 失败时宁可让窗口正常关掉，也不要卡住关不掉。
          await getCurrentWindow().hide();
          e.preventDefault();
        } catch (err) {
          console.error(err);
        }
      })
      .then((u) => { unlisten = u; })
      .catch(() => undefined);
    return () => { unlisten?.(); };
  }, []);
}
