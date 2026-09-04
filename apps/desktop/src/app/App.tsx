import { RouterProvider } from 'react-router';
import { router } from './router';
import { ToastHost } from '@/components/Toast';
import { useCloseToDock } from './closeToDock';

export function App() {
  useCloseToDock();
  return (
    <>
      <RouterProvider router={router} />
      <ToastHost />
    </>
  );
}
