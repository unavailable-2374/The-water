import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  DATABASE_URL: z.string().min(1).default('./data/dev.sqlite'),
  TRUST_PROXY: z.enum(['0', '1']).default('0'),
  EXTRA_ORIGINS: z.string().default(''),
  ADMIN_EMAILS: z.string().default(''),
  PUBLIC_BASE_URL: z.string().default(''),
  /** argon2id 参数（测试可调低以加速）。 */
  PASSWORD_MEMORY_COST: z.coerce.number().int().min(1024).default(65536),
  PASSWORD_TIME_COST: z.coerce.number().int().min(1).default(2),
});

export type Env = {
  port: number;
  databaseUrl: string;
  trustProxy: boolean;
  extraOrigins: string[];
  adminEmails: string[];
  publicBaseUrl: string;
  passwordMemoryCost: number;
  passwordTimeCost: number;
};

function splitList(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const raw = EnvSchema.parse(source);
  return {
    port: raw.PORT,
    databaseUrl: raw.DATABASE_URL,
    trustProxy: raw.TRUST_PROXY === '1',
    extraOrigins: splitList(raw.EXTRA_ORIGINS),
    adminEmails: splitList(raw.ADMIN_EMAILS).map((e) => e.toLowerCase()),
    publicBaseUrl: raw.PUBLIC_BASE_URL,
    passwordMemoryCost: raw.PASSWORD_MEMORY_COST,
    passwordTimeCost: raw.PASSWORD_TIME_COST,
  };
}

/** 测试用：默认值 + 快速密码哈希。 */
export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...loadEnv({}),
    passwordMemoryCost: 8192,
    passwordTimeCost: 1,
    adminEmails: ['admin@example.com'],
    ...overrides,
  };
}
