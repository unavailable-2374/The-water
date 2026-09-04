/**
 * 导出诊断包：把版本、系统信息、脱敏后的配置、最近错误与日志打成一个 zip，
 * 让用户直接附在反馈里。
 *
 * 全流程只在用户点按钮时发生，不做任何自动上报，也不联网。
 * 脱敏规则见 `redact.ts`，内容组装见 `collect.ts`。
 */
import { strToU8, zipSync } from 'fflate';
import { buildDiagnosticsFiles, diagnosticsFileName, type DiagnosticsInput, type ProviderLike } from './collect';
import { recentErrors } from './recentErrors';

/** 单个日志文件最多带走多少字节（取文件尾部，最近的内容最有用）。 */
export const LOG_TAIL_BYTES = 256 * 1024;
/** 最多带走几个日志文件。 */
export const MAX_LOG_FILES = 6;

/** 把文件表压成 zip 字节。纯函数，测试直接用。 */
export function zipDiagnostics(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, text] of Object.entries(files)) entries[name] = strToU8(text);
  return zipSync(entries, { level: 6 });
}

async function readLogFiles(): Promise<Array<{ name: string; text: string }>> {
  try {
    const { BaseDirectory, readDir, readTextFile } = await import('@tauri-apps/plugin-fs');
    const items = await readDir('', { baseDir: BaseDirectory.AppLog });
    const names = items
      .filter((e) => e.isFile)
      .map((e) => e.name)
      .filter((n): n is string => Boolean(n))
      .sort()
      .slice(-MAX_LOG_FILES);
    const out: Array<{ name: string; text: string }> = [];
    for (const name of names) {
      try {
        const text = await readTextFile(name, { baseDir: BaseDirectory.AppLog });
        out.push({ name, text: text.length > LOG_TAIL_BYTES ? `…（已截去前面 ${text.length - LOG_TAIL_BYTES} 字）\n${text.slice(-LOG_TAIL_BYTES)}` : text });
      } catch {
        out.push({ name, text: '（这个日志文件读不出来）' });
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function readCounts(): Promise<Record<string, number>> {
  try {
    const { getDb } = await import('@/db/db');
    const db = getDb();
    const out: Record<string, number> = {};
    for (const [label, table] of [['文档', 'documents'], ['小说', 'novels'], ['章节', 'chapters'], ['任务', 'jobs'], ['高亮', 'highlights']] as const) {
      const rows = await db.select<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`).catch(() => []);
      if (rows[0]) out[label] = Number(rows[0].c);
    }
    return out;
  } catch {
    return {};
  }
}

async function readAppInfo(): Promise<DiagnosticsInput['app'] & { data: string; log: string }> {
  const unknown = '未知';
  let version = unknown;
  let tauriVersion = unknown;
  let data = unknown;
  let log = unknown;
  let platform = unknown;
  let arch = unknown;
  let osVersion = unknown;
  try {
    const [app, path] = await Promise.all([import('@tauri-apps/api/app'), import('@tauri-apps/api/path')]);
    [version, tauriVersion, data, log] = await Promise.all([app.getVersion(), app.getTauriVersion(), path.appDataDir(), path.appLogDir()]);
  } catch {
    /* 浏览器里跑（vite dev 直连）时拿不到，保留「未知」 */
  }
  try {
    const os = await import('@tauri-apps/plugin-os');
    [platform, arch, osVersion] = [os.platform(), os.arch(), os.version()];
  } catch {
    platform = typeof navigator === 'undefined' ? unknown : navigator.platform || unknown;
  }
  return { version, tauriVersion, platform, arch, osVersion, data, log };
}

/** 采集一份诊断输入。任何一项取不到都降级成「未知」，不让导出整体失败。 */
export async function collectDiagnostics(at: Date = new Date()): Promise<DiagnosticsInput> {
  const info = await readAppInfo();
  let settings: Record<string, unknown> = {};
  let providers: ProviderLike[] = [];
  try {
    const { loadAppSettings } = await import('@/db/repos/settingsRepo');
    settings = (await loadAppSettings()) as unknown as Record<string, unknown>;
  } catch {
    /* 取不到就留空 */
  }
  try {
    const { listProviders } = await import('@/db/repos/providersRepo');
    providers = (await listProviders()) as unknown as ProviderLike[];
  } catch {
    /* 取不到就留空 */
  }
  const nav = typeof navigator === 'undefined' ? null : navigator;
  return {
    at,
    app: { version: info.version, tauriVersion: info.tauriVersion, platform: info.platform, arch: info.arch, osVersion: info.osVersion },
    dirs: { data: info.data, log: info.log },
    runtime: {
      userAgent: nav?.userAgent ?? '未知',
      language: nav?.language ?? '未知',
      screen: typeof screen === 'undefined' ? '未知' : `${screen.width}×${screen.height} @${window.devicePixelRatio ?? 1}x`,
      online: nav?.onLine ?? true,
    },
    settings,
    providers,
    errors: recentErrors(),
    logs: await readLogFiles(),
    counts: await readCounts(),
  };
}

/**
 * 走保存对话框把诊断包写到用户选的位置。
 * 返回写入路径；用户取消返回 null。
 */
export async function exportDiagnosticsBundle(at: Date = new Date()): Promise<string | null> {
  const input = await collectDiagnostics(at);
  const bytes = zipDiagnostics(buildDiagnosticsFiles(input));
  const { save } = await import('@tauri-apps/plugin-dialog');
  const path = await save({ defaultPath: diagnosticsFileName(at), filters: [{ name: '诊断包', extensions: ['zip'] }] });
  if (!path) return null;
  const { writeFile } = await import('@tauri-apps/plugin-fs');
  await writeFile(path, bytes);
  return path;
}
