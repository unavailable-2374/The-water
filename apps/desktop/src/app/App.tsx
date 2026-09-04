import { Fragment } from 'react';
import { RouterProvider } from 'react-router';
import { router } from './router';
import { ToastHost } from '@/components/Toast';
import { ConfirmHost } from '@/components/ui';
import { useLocale } from '@/i18n';
import { useCloseToDock } from './closeToDock';
import { DropImport } from '@/documents/DropImport';

export function App() {
  useCloseToDock();
  // 语言变了就把整棵树重挂一遍。切语言是低频操作，用重挂换「不会有半个界面留在旧语言」。
  const locale = useLocale();
  return (
    <Fragment key={locale}>
      <RouterProvider router={router} />
      {/* 窗口级拖拽导入：Tauri v2 的 dragDropEnabled 默认开启，不需要改 tauri.conf.json。 */}
      <DropImport />
      <ToastHost />
      <ConfirmHost />
    </Fragment>
  );
}
