import { RouterProvider } from 'react-router';
import { router } from './router';
import { ToastHost } from '@/components/Toast';
import { ConfirmHost } from '@/components/ui';
import { useCloseToDock } from './closeToDock';
import { DropImport } from '@/documents/DropImport';

export function App() {
  useCloseToDock();
  return (
    <>
      <RouterProvider router={router} />
      {/* 窗口级拖拽导入：Tauri v2 的 dragDropEnabled 默认开启，不需要改 tauri.conf.json。 */}
      <DropImport />
      <ToastHost />
      <ConfirmHost />
    </>
  );
}
