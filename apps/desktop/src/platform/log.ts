/**
 * 前端日志：把 webview 里的错误 / 警告送进 Rust 侧 `tauri-plugin-log` 写的日志文件，
 * 这样「导出诊断包」里就有前后端同一份时间线。
 *
 * 不在 Tauri 里跑（vite dev 直连浏览器）时全部静默降级，只留原生 console。
 */
import { recordError } from '@/diagnostics/recentErrors';

type Level = 'error' | 'warn' | 'info';

let sink: ((level: Level, message: string) => void) | null = null;
let loading: Promise<void> | null = null;

/** 懒加载日志插件：加载失败就永久走原生 console，不再重试。 */
async function ensureSink(): Promise<void> {
  if (sink || loading) return loading ?? undefined;
  loading = (async () => {
    try {
      const log = await import('@tauri-apps/plugin-log');
      sink = (level, message) => {
        void (level === 'error' ? log.error(message) : level === 'warn' ? log.warn(message) : log.info(message));
      };
    } catch {
      sink = () => undefined;
    }
  })();
  return loading;
}

/** 把一段文字写进日志文件。永不抛。 */
export function writeLog(level: Level, message: string): void {
  void ensureSink().then(() => {
    try {
      sink?.(level, message);
    } catch {
      /* 日志写不进去不该影响业务 */
    }
  });
}

function stringify(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ''}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

let uninstall: (() => void) | null = null;

/**
 * 接管 console.error / console.warn：原样打到控制台，同时抄一份进日志文件，
 * error 还会进「最近错误」缓冲。返回卸载函数，幂等。
 */
export function installConsoleForwarding(): () => void {
  if (typeof console === 'undefined') return () => undefined;
  uninstall?.();
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...args: unknown[]): void => {
    origError(...args);
    const text = stringify(args);
    writeLog('error', text);
    recordError({ error: args.find((a) => a instanceof Error) ?? text, scope: 'console.error' });
  };
  console.warn = (...args: unknown[]): void => {
    origWarn(...args);
    writeLog('warn', stringify(args));
  };
  uninstall = () => {
    console.error = origError;
    console.warn = origWarn;
    uninstall = null;
  };
  return uninstall;
}
