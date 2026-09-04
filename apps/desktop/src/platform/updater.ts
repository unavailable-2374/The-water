/**
 * 自动更新。
 *
 * 更新端点与签名公钥配在 `src-tauri/tauri.conf.json` 的 `plugins.updater` 里；
 * 私钥只存在 CI 的 secret 里，永远不进仓库（发布流程见 docs/RELEASE.md）。
 *
 * 检查与下载都由 Rust 侧 `tauri-plugin-updater` 用 reqwest 发起，
 * **不经过 webview 的网络栈**，所以 CSP 的 connect-src 不需要为更新端点开口子。
 */

/** 下载进度：total 为 null 表示服务端没给 Content-Length。 */
export interface DownloadProgress {
  downloaded: number;
  total: number | null;
}

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  /** 发布说明，可能为空。 */
  notes: string;
  /** 发布时间原文，可能为空。 */
  date: string | null;
}

export type UpdateCheck =
  | { state: 'available'; update: AvailableUpdate }
  | { state: 'up-to-date' }
  /** 不在 Tauri 里跑、没配公钥、或者网络 / 端点出错。reason 可直接显示给用户。 */
  | { state: 'unavailable'; reason: string };

type UpdateHandle = {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
  downloadAndInstall(onEvent?: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void): Promise<void>;
  close(): Promise<void>;
};

/** check() 拿到的句柄要留到安装时用。 */
let pending: UpdateHandle | null = null;

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 判断这台机器上到底有没有更新能力（没打包、没配公钥都算没有）。 */
function unavailableReason(e: unknown): string {
  const msg = messageOf(e);
  if (/not allowed|forbidden|permission/i.test(msg)) return '这个构建没有开启自动更新。';
  if (/pubkey|public key|signature/i.test(msg)) return '这个构建没有配置更新签名公钥，无法验证更新包。';
  return `检查更新失败：${msg}`;
}

/**
 * 检查是否有新版本。永不抛：任何失败都变成 `unavailable` 并带上人能读的原因。
 */
export async function checkForUpdate(): Promise<UpdateCheck> {
  await disposePending();
  let check: typeof import('@tauri-apps/plugin-updater').check;
  try {
    ({ check } = await import('@tauri-apps/plugin-updater'));
  } catch {
    return { state: 'unavailable', reason: '当前不是打包后的桌面应用，无法检查更新。' };
  }
  try {
    const update = await check();
    if (!update) return { state: 'up-to-date' };
    pending = update as unknown as UpdateHandle;
    return {
      state: 'available',
      update: {
        version: update.version,
        currentVersion: update.currentVersion,
        notes: update.body ?? '',
        date: update.date ?? null,
      },
    };
  } catch (e) {
    return { state: 'unavailable', reason: unavailableReason(e) };
  }
}

/**
 * 下载并安装上一次 `checkForUpdate()` 找到的版本。
 * macOS 上装完不会自动重启，需要调用方再调 `relaunchApp()`。
 */
export async function installPendingUpdate(onProgress?: (p: DownloadProgress) => void): Promise<void> {
  const update = pending;
  if (!update) throw new Error('没有待安装的更新，请先检查更新。');
  let downloaded = 0;
  let total: number | null = null;
  await update.downloadAndInstall((e) => {
    if (e.event === 'Started') total = e.data?.contentLength ?? null;
    else if (e.event === 'Progress') downloaded += e.data?.chunkLength ?? 0;
    else if (e.event === 'Finished') downloaded = total ?? downloaded;
    onProgress?.({ downloaded, total });
  });
}

/** 装完更新后重启应用。 */
export async function relaunchApp(): Promise<void> {
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}

/** 放掉没用上的更新句柄（Rust 侧的 Resource 需要显式释放）。 */
export async function disposePending(): Promise<void> {
  const update = pending;
  pending = null;
  if (update) await update.close().catch(() => undefined);
}

/** 进度百分比，拿不到总长度时返回 null。 */
export function progressPercent(p: DownloadProgress): number | null {
  if (!p.total || p.total <= 0) return null;
  return Math.min(100, Math.round((p.downloaded / p.total) * 100));
}
