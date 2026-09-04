/**
 * 桌面端内容安全策略（CSP）。
 *
 * 这里是唯一的事实来源：`src-tauri/tauri.conf.json` 的 `app.security.csp` / `devCsp`
 * 必须与 `buildCsp()` / `buildDevCsp()` 的输出逐字一致，`test/app/csp.test.ts` 会比对。
 * 改策略时先改这里，再把测试报出来的字符串抄回 tauri.conf.json。
 *
 * 几条前提（都在代码里核对过，改动前请复核）：
 * - LLM 与云端请求全部走 `@tauri-apps/plugin-http`，它内部是 `invoke('plugin:http|fetch')`，
 *   由 Rust 端出网，**不经过 webview 网络栈**，因此 connect-src 并不需要枚举各供应商域名。
 *   真正的出站白名单在 `src-tauri/capabilities/default.json` 的 `http:default` scope 里。
 * - Tauri 的 IPC 首选实现是 `fetch(convertFileSrc(cmd, 'ipc'))`，受 connect-src 管，
 *   所以必须放行 `ipc:`（macOS/Linux）与 `http://ipc.localhost`（Windows/Android）。
 * - PDF 走 asset 协议：pdf.js 用 fetch 拉 `asset://localhost/...`，所以 asset 既要进
 *   img-src 也要进 connect-src。
 * - pdf.js 的字体走 `@font-face { src: url(data:font/opentype;base64,...) }`，需要 font-src data:。
 * - pdf.worker 里有 WebAssembly；worker 脚本自身无 CSP 头，但保留 'wasm-unsafe-eval' 以防内联。
 */

/** 指令名 → 源列表。空列表表示指令不带任何源（如 `upgrade-insecure-requests`）。 */
export type CspDirectives = Record<string, readonly string[]>;

/** asset 协议在两类平台上的形态。 */
const ASSET = ['asset:', 'http://asset.localhost'] as const;
/** Tauri IPC 在两类平台上的形态。 */
const IPC = ['ipc:', 'http://ipc.localhost'] as const;
/** 用户可自填 Base URL，无法枚举主机；本地自建服务也要能连。 */
const USER_ENDPOINTS = ['https:', 'http://localhost:*', 'http://127.0.0.1:*'] as const;

export const CSP_DIRECTIVES: CspDirectives = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'wasm-unsafe-eval'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:', ...ASSET],
  'font-src': ["'self'", 'data:'],
  'media-src': ["'self'", 'blob:', ...ASSET],
  'worker-src': ["'self'", 'blob:'],
  'connect-src': ["'self'", 'blob:', ...IPC, ...ASSET, ...USER_ENDPOINTS],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
};

/** 开发态额外放行：vite 的 HMR websocket 与 react-refresh 的内联脚本。 */
export const DEV_EXTRA_SOURCES: CspDirectives = {
  'script-src': ["'unsafe-inline'", "'unsafe-eval'"],
  'connect-src': ['ws://localhost:*', 'ws://127.0.0.1:*', 'http://localhost:*', 'http://127.0.0.1:*'],
};

/**
 * 序列化成单行策略串。
 *
 * Tauri 用 `policy.split(';')` + `directive.trim().split(' ')` 解析，所以这里
 * 必须是单空格分隔、无换行、无结尾分号，否则会解析出一条空指令。
 */
export function serializeCsp(directives: CspDirectives): string {
  return Object.entries(directives)
    .map(([name, sources]) => (sources.length > 0 ? `${name} ${sources.join(' ')}` : name))
    .join('; ');
}

/** 合并两份指令表，右侧的源追加到左侧同名指令后（去重）。 */
export function mergeDirectives(base: CspDirectives, extra: CspDirectives): CspDirectives {
  const out: Record<string, string[]> = {};
  for (const [name, sources] of Object.entries(base)) out[name] = [...sources];
  for (const [name, sources] of Object.entries(extra)) {
    const cur = out[name] ?? (out[name] = []);
    for (const s of sources) if (!cur.includes(s)) cur.push(s);
  }
  return out;
}

/** 生产态策略。 */
export function buildCsp(): string {
  return serializeCsp(CSP_DIRECTIVES);
}

/** 开发态策略（`tauri dev` 直连 vite 时其实不会注入，留着是为了 `frontendDist` 预览也安全）。 */
export function buildDevCsp(): string {
  return serializeCsp(mergeDirectives(CSP_DIRECTIVES, DEV_EXTRA_SOURCES));
}
