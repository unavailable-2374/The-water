/**
 * 供应商高级项的解析与校验：自定义请求头、代理、超时、并发。
 * 表单里是纯文本 / 秒，落库前在这里收敛成结构化的值。
 */
import { DEFAULT_FIRST_BYTE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS } from '@/llm/config';

/** 一行一条 `Key: Value` 解析成对象；空行与 `#` 开头的注释行忽略。 */
export function parseHeaders(text: string): { headers: Record<string, string>; errors: string[] } {
  const headers: Record<string, string> = {};
  const errors: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep <= 0) {
      errors.push(`这一行不是「名称: 值」的格式：${line}`);
      continue;
    }
    const name = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      errors.push(`请求头名称不合法：${name}`);
      continue;
    }
    headers[name] = value;
  }
  return { headers, errors };
}

/** 反过来：对象序列化成一行一条，用于回填表单。 */
export function formatHeaders(headers: Record<string, string> | null | undefined): string {
  if (!headers) return '';
  return Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n');
}

export interface RuntimeFields {
  firstByteTimeoutMs: number;
  idleTimeoutMs: number;
  proxyUrl: string;
  concurrency: number;
}

/** 与 llm/config.ts 的兜底值、迁移 0004 的列默认值保持一致。 */
export const RUNTIME_DEFAULTS: RuntimeFields = {
  firstByteTimeoutMs: DEFAULT_FIRST_BYTE_TIMEOUT_MS,
  idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
  proxyUrl: '',
  concurrency: 1,
};

/** 秒 ↔ 毫秒：表单里填秒，库里存毫秒。 */
export function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1000);
}
export function msToSeconds(ms: number): number {
  return Math.round(ms / 1000);
}

const MIN_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 600000;
const MAX_CONCURRENCY = 16;

/** 代理地址：留空表示不用代理；否则必须是 http/https/socks5 的完整地址。 */
export function validateProxyUrl(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return '代理地址格式不对，例如 http://127.0.0.1:7890';
  }
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(u.protocol)) return '代理只支持 http / https / socks5';
  if (!u.hostname) return '代理地址缺少主机名';
  return null;
}

/** 校验四个运行时字段，返回错误列表（空数组表示都合法）。 */
export function validateRuntimeFields(f: RuntimeFields): string[] {
  const errors: string[] = [];
  const range = (label: string, v: number) => {
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < MIN_TIMEOUT_MS || v > MAX_TIMEOUT_MS) {
      errors.push(`${label}需要在 ${MIN_TIMEOUT_MS / 1000}–${MAX_TIMEOUT_MS / 1000} 秒之间`);
    }
  };
  range('首字节超时', f.firstByteTimeoutMs);
  range('空闲超时', f.idleTimeoutMs);
  if (!Number.isInteger(f.concurrency) || f.concurrency < 1 || f.concurrency > MAX_CONCURRENCY) {
    errors.push(`并发数需要是 1–${MAX_CONCURRENCY} 之间的整数`);
  }
  const proxyError = validateProxyUrl(f.proxyUrl);
  if (proxyError) errors.push(proxyError);
  return errors;
}

/** Base URL 校验：必须是 http/https 绝对地址。 */
export function validateBaseUrl(value: string): string | null {
  const v = value.trim();
  if (!v) return 'Base URL 不能为空';
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return 'Base URL 需要是完整地址，例如 https://api.deepseek.com';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Base URL 只支持 http / https';
  if (!u.hostname) return 'Base URL 缺少主机名';
  return null;
}
