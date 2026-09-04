import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { App } from './app/App';
import { bootstrap } from './app/bootstrap';
import { applyCachedTheme } from './app/theme';
import { fmt, initLocale, t } from './i18n';
import { installDiagnostics } from './diagnostics';

import { toast, ToastHost } from './components/Toast';
import { ErrorBoundary, ErrorPanel } from './components/ErrorBoundary';

// 先按上次的选择涂一遍主题，避免设置读出来之前闪一下白。
applyCachedTheme();
// 语言同理：先定下来再渲染，顺手把 <html lang> 写对（index.html 里那个只是占位）。
initLocale();
// 接上 console 转发与全局错误捕获：console.error / console.warn 会同时写进日志文件，
// 「导出诊断包」才有内容可带。要赶在任何业务模块可能报错之前装上，幂等。
installDiagnostics();

window.addEventListener('error', (e) => { console.error(e.error ?? e.message); toast.error(fmt(t.error.runtimeError, { message: e.message })); });
window.addEventListener('unhandledrejection', (e) => { const r = e.reason; console.error(r); toast.error(fmt(t.error.unhandledError, { message: r instanceof Error ? r.message : String(r) })); });

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<div className="flex h-full items-center justify-center text-sm text-ink-400 font-serif">{t.app.starting}</div>);

bootstrap()
  .then(() => root.render(
    <React.StrictMode>
      {/* 根级错误边界：路由之外（Toast、确认框、AppShell 之上）出错也不至于白屏。 */}
      <ErrorBoundary scope={t.error.appScope}>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  ))
  .catch((err: unknown) => {
    console.error(err);
    root.render(<><ErrorPanel error={err} scope={t.error.startScope} /><ToastHost /></>);
  });
