import type { z } from 'zod';

export function parseJson<T>(schema: z.ZodType<T>, text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    const r = schema.safeParse(JSON.parse(text));
    return r.success ? r.data : fallback;
  } catch {
    return fallback;
  }
}

export function parseJsonLoose<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function bool(v: unknown): boolean {
  return v === 1 || v === true || v === '1';
}

export function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : fallback;
}

export function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v == null ? fallback : String(v);
}

export function nullableStr(v: unknown): string | null {
  return v == null ? null : String(v);
}

export function nullableNum(v: unknown): number | null {
  return v == null ? null : num(v);
}
