import { validation } from './errors';

export interface KeysetCursor {
  /** 排序键值（数字：时间戳 ms 或计数）。 */
  v: number;
  /** 同键时按 id 倒序去重。 */
  id: string;
}

function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}
function b64urlDecode(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}

export function encodeCursor(c: KeysetCursor): string {
  return b64urlEncode(JSON.stringify([c.v, c.id]));
}

export function decodeCursor(raw: string | undefined): KeysetCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(b64urlDecode(raw)) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error('shape');
    const [v, id] = parsed;
    if (typeof v !== 'number' || !Number.isFinite(v) || typeof id !== 'string') throw new Error('shape');
    return { v, id };
  } catch {
    throw validation('游标无效');
  }
}
