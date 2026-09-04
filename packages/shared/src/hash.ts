import { normalizeChapterText } from './text';

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
  return s;
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return toHex(digest);
}

/** 章节内容 hash：对归一化后的 UTF-8 文本做 sha256。 */
export async function hashChapterContent(content: string): Promise<string> {
  return sha256Hex(normalizeChapterText(content));
}

/** 键排序的稳定 JSON 序列化，用于对结构化对象求 hash。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) {
      const val = o[k];
      if (val !== undefined) out[k] = sortKeys(val);
    }
    return out;
  }
  return v;
}

export async function hashStoryline(doc: unknown): Promise<string> {
  return sha256Hex(canonicalJson(doc));
}

export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}
