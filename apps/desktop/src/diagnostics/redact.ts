/**
 * 诊断包脱敏。
 *
 * 硬要求：导出的诊断包里**绝不能**出现 API Key、密码、会话 token 的原文。
 * 这里的策略是「宁可多打码」——把可疑的东西一律换掉，哪怕偶尔误伤一个哈希值，
 * 也好过把用户的密钥发给我们。`test/diagnostics/redact.test.ts` 会构造含密钥的配置，
 * 断言最终产出的 zip 里搜不到密钥原文。
 */

export const REDACTED = '[已脱敏]';

/** 一眼就能认出的密钥形状。先按这些替换，命中即整段换掉。 */
const SECRET_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{6,}/g, // OpenAI / DeepSeek / Moonshot 等
  /\bsk_(?:live|test)_[A-Za-z0-9]{6,}/g,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{12,}/g,
  /\bAIza[0-9A-Za-z_-]{16,}/g, // Google
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g, // Slack
  /\bAKIA[0-9A-Z]{12,}/g, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, // JWT
  /\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

/** 键名带这些词时，无论值长什么样都整体打码。 */
const SENSITIVE_KEY = /^(?:.*[-_])?(?:api[-_]?key|apikey|key|secret|token|password|passwd|pwd|authorization|auth|credential|cookie|session|signature|sign)(?:[-_].*)?$/i;

/** 文本里的 `xxx_key = 值` / `"token": "值"` / `?api_key=值`。 */
const SENSITIVE_ASSIGNMENT =
  /(["']?\b[A-Za-z0-9_-]*(?:api[-_]?key|apikey|secret|token|password|passwd|pwd|authorization|credential|cookie|session)[A-Za-z0-9_-]*\b["']?)(\s*[:=]\s*)(["'][^"']*["']|[^\s,;&)}\]]+)/gi;

/** URL 里的 user:password@ 段。 */
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)([^/@\s:]+)(?::[^/@\s]*)?@/gi;

/**
 * 不认识形状、但看着就是随机密钥的长串：
 * 32 位以上的 [A-Za-z0-9_-]，且同时含大写、小写和数字。
 * 这样能避开纯小写十六进制的 sha256 与带连字符的 UUID / nanoid，
 * 又能兜住我们没枚举到的供应商密钥格式。
 */
export function looksLikeSecretToken(s: string): boolean {
  if (s.length < 32) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return false;
  return /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s);
}

const OPAQUE_RUN = /[A-Za-z0-9_-]{32,}/g;

/** 把任意一段自由文本（日志行、错误消息、堆栈）脱敏。 */
export function redactText(input: string): string {
  let out = input;
  out = out.replace(URL_USERINFO, (_m, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`);
  out = out.replace(SENSITIVE_ASSIGNMENT, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`);
  for (const re of SECRET_SHAPES) out = out.replace(re, REDACTED);
  out = out.replace(OPAQUE_RUN, (m) => (looksLikeSecretToken(m) ? REDACTED : m));
  return out;
}

/** URL 只保留协议、主机、端口与路径：query 里常常直接带 key。 */
export function redactUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return s;
  try {
    const u = new URL(s);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    const query = u.search || u.hash ? ` ${REDACTED}（已去掉 query）` : '';
    return `${u.origin}${u.pathname}${query}`;
  } catch {
    return redactText(s);
  }
}

/** 请求头：名字留着（我们要知道用户加了哪些头），值一律打码。 */
export function redactHeaders(headers: Record<string, string> | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(headers ?? {})) out[name] = REDACTED;
  return out;
}

/**
 * 递归脱敏任意 JSON 值：
 * 键名敏感 → 值整体打码；字符串 → 走 redactText；其余原样。
 */
export function redactJson(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key)) return typeof value === 'string' || typeof value === 'number' ? REDACTED : REDACTED;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redactJson(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactJson(v, k);
    return out;
  }
  return value;
}

/** 只留头尾各 4 位的短标识（clientId 这类既要能对上、又不该全量外泄的值）。 */
export function maskId(id: string): string {
  if (!id) return '';
  if (id.length <= 8) return `${id.slice(0, 2)}…`;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}
