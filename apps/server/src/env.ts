import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  DATABASE_URL: z.string().min(1).default('./data/dev.sqlite'),
  TRUST_PROXY: z.enum(['0', '1']).default('0'),
  EXTRA_ORIGINS: z.string().default(''),
  ADMIN_EMAILS: z.string().default(''),
  PUBLIC_BASE_URL: z.string().default(''),
  /** 可信代理 IP / CIDR 列表；TRUST_PROXY=1 且来源命中才采信 X-Forwarded-For。 */
  TRUSTED_PROXIES: z.string().default(''),
  /** 邮件出口：console 只打印（开发用），smtp / resend 为真实投递。 */
  MAIL_TRANSPORT: z.enum(['console', 'smtp', 'resend']).default('console'),
  MAIL_FROM: z.string().default('The Water <no-reply@localhost>'),
  SMTP_URL: z.string().default(''),
  RESEND_API_KEY: z.string().default(''),
  /** 内容审核模式：off 关闭（仅测试）、rules 本地规则引擎。 */
  MODERATION_MODE: z.enum(['off', 'rules']).default('rules'),
  /** 追加违禁词表文件路径（每行一条，# 开头为注释）。 */
  MODERATION_BLOCKLIST_PATH: z.string().default(''),
  /** 每用户 blob 存储配额（字节），0 表示不限制。 */
  STORAGE_QUOTA_BYTES: z.coerce.number().int().min(0).default(200 * 1024 * 1024),
  /** 备份输出目录。 */
  BACKUP_DIR: z.string().default('./data/backups'),
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
  trustedProxies: string[];
  mailTransport: 'console' | 'smtp' | 'resend';
  mailFrom: string;
  smtpUrl: string;
  resendApiKey: string;
  moderationMode: 'off' | 'rules';
  moderationBlocklistPath: string;
  storageQuotaBytes: number;
  backupDir: string;
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
    trustedProxies: splitList(raw.TRUSTED_PROXIES),
    mailTransport: raw.MAIL_TRANSPORT,
    mailFrom: raw.MAIL_FROM,
    smtpUrl: raw.SMTP_URL,
    resendApiKey: raw.RESEND_API_KEY,
    moderationMode: raw.MODERATION_MODE,
    moderationBlocklistPath: raw.MODERATION_BLOCKLIST_PATH,
    storageQuotaBytes: raw.STORAGE_QUOTA_BYTES,
    backupDir: raw.BACKUP_DIR,
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
    moderationMode: 'off',
    ...overrides,
  };
}
