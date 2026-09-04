import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { App } from './app/App';
import { bootstrap } from './app/bootstrap';
import { applyCachedTheme } from './app/theme';

import { toast, ToastHost } from './components/Toast';
import { ErrorBoundary, ErrorPanel } from './components/ErrorBoundary';

// 先按上次的选择涂一遍主题，避免设置读出来之前闪一下白。
applyCachedTheme();

window.addEventListener('error', (e) => { console.error(e.error ?? e.message); toast.error(`运行错误：${e.message}`); });
window.addEventListener('unhandledrejection', (e) => { const r = e.reason; console.error(r); toast.error(`未处理的错误：${r instanceof Error ? r.message : String(r)}`); });

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<div className="flex h-full items-center justify-center text-sm text-ink-400 font-serif">正在启动…</div>);

bootstrap()
  .then(() => root.render(
    <React.StrictMode>
      {/* 根级错误边界：路由之外（Toast、确认框、AppShell 之上）出错也不至于白屏。 */}
      <ErrorBoundary scope="应用">
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  ))
  .catch((err: unknown) => {
    console.error(err);
    root.render(<><ErrorPanel error={err} scope="启动" /><ToastHost /></>);
  });
