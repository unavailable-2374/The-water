import { useCallback, type ReactNode } from 'react';
import { confirm as globalConfirm } from './ui';

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmText?: string;
  danger?: boolean;
}

/**
 * 兼容旧调用点的 hook 版确认框。
 *
 * 真正的实现在 `components/ui.tsx`：`confirm()` 往全局队列里塞一条，由挂在
 * `app/App.tsx` 的 `<ConfirmHost />` 统一渲染。所以这里的 `dialog` 恒为 null，
 * 调用处的 `{dialog}` 保留着也无妨。
 *
 * 新代码直接用 `import { confirm } from '@/components/ui'`，不需要这个 hook。
 */
export function useConfirm(): { confirm: (opts: ConfirmOptions) => Promise<boolean>; dialog: ReactNode } {
  const confirm = useCallback((opts: ConfirmOptions) => globalConfirm({
    title: opts.title,
    description: opts.description,
    confirmText: opts.confirmText,
    tone: opts.danger ? 'danger' : 'default',
  }), []);
  return { confirm, dialog: null };
}
