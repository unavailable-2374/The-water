import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { App } from './app/App';
import { bootstrap } from './app/bootstrap';

import { toast } from './components/Toast';

window.addEventListener('error', (e) => { console.error(e.error ?? e.message); toast.error(`运行错误：${e.message}`); });
window.addEventListener('unhandledrejection', (e) => { const r = e.reason; console.error(r); toast.error(`未处理的错误：${r instanceof Error ? r.message : String(r)}`); });

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<div className="flex h-full items-center justify-center text-sm text-ink-400 font-serif">正在启动…</div>);

bootstrap()
  .then(() => root.render(<React.StrictMode><App /></React.StrictMode>))
  .catch((err: unknown) => {
    console.error(err);
    root.render(
      <div className="p-8 text-sm">
        <h1 className="mb-2 text-lg font-semibold text-red-600">启动失败</h1>
        <pre className="whitespace-pre-wrap text-xs">{err instanceof Error ? err.stack ?? err.message : String(err)}</pre>
      </div>,
    );
  });
