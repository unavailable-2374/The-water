import { sha256Hex } from '@the-water/shared';
import type { Env } from '../env';

export const TOKEN_PREFIX = 'tw_';

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 生成 `tw_` + 43 字符 base64url（32 字节随机）。 */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return TOKEN_PREFIX + base64url(bytes);
}

export function isTokenShape(token: string): boolean {
  return /^tw_[A-Za-z0-9_-]{43}$/.test(token);
}

export async function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
}

export async function hashPassword(env: Env, password: string): Promise<string> {
  return Bun.password.hash(password, {
    algorithm: 'argon2id',
    memoryCost: env.passwordMemoryCost,
    timeCost: env.passwordTimeCost,
  });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}
