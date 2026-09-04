/**
 * 桌面端可观测性入口。
 *
 * - 日志：Rust 侧 `tauri-plugin-log` 写到系统日志目录并按大小轮转；
 *   前端通过 `@/platform/log` 把 console 的错误 / 警告也送进同一份文件。
 * - 错误：`recentErrors` 在内存里留最近 50 条。
 * - 诊断包：用户主动导出，内容全部脱敏，不联网、不自动上报。
 */
export { buildDiagnosticsFiles, diagnosticsFileName, redactProvider, type DiagnosticsInput, type ProviderLike } from './collect';
export { collectDiagnostics, exportDiagnosticsBundle, zipDiagnostics } from './bundle';
export { MAX_RECENT_ERRORS, clearRecentErrors, installGlobalErrorCapture, recentErrors, recordError, type RecordedError } from './recentErrors';
export { REDACTED, looksLikeSecretToken, maskId, redactHeaders, redactJson, redactText, redactUrl } from './redact';

import { installConsoleForwarding } from '@/platform/log';
import { installGlobalErrorCapture } from './recentErrors';

let installed = false;

/**
 * 应用启动时调一次：接上 console 转发与全局错误捕获。
 * 幂等，重复调用只生效一次。
 */
export function installDiagnostics(): void {
  if (installed) return;
  installed = true;
  installConsoleForwarding();
  installGlobalErrorCapture();
}
