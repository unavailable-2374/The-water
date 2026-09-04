import type { Env } from '../env';

/** 站外可分享的绝对地址；未配置 PUBLIC_BASE_URL 时为 null（客户端据此隐藏分享入口）。 */
export function novelShareUrl(env: Env, novelId: string): string | null {
  const base = env.publicBaseUrl.replace(/\/+$/, '');
  return base ? `${base}/n/${encodeURIComponent(novelId)}` : null;
}

export function authorShareUrl(env: Env, handle: string): string | null {
  const base = env.publicBaseUrl.replace(/\/+$/, '');
  return base ? `${base}/u/${encodeURIComponent(handle)}` : null;
}
