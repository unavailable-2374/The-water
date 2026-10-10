import { resolve } from 'node:path';
import { z } from 'zod';

const EnvSchema = z.object({
  WRITING_HARNESS_ENABLED: z.enum(['0', '1']).default('0'),
  LUNAROUTE_API_KEY: z.string().default(''),
  WRITING_MODEL: z.string().min(1).default('deepseek-4.1-flash'),
  WRITING_HARNESS_STORAGE: z.string().default(''),
  WRITING_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  WRITING_MEMORY_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  WRITING_RETENTION_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  WRITING_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1024).max(262144).default(262144),
  WRITING_REASONING_TOKENS: z.coerce.number().int().min(0).max(262143).default(32000),
  WRITING_REASONING_EFFORT: z.enum(['low', 'medium', 'high']).default('low'),
  WRITING_JSON_MODE: z.enum(['json_object', 'json_schema']).default('json_schema'),
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
  /** 桌面端安装包下载地址，网页 CTA 用；留空时 /download 页面明说未配置。 */
  DOWNLOAD_URL: z.string().default(''),
  /** 请求日志格式：off 不打、text 人读（本地）、json 一行 JSON（采集器）。 */
  LOG_FORMAT: z.enum(['off', 'text', 'json']).default('text'),
  /** 指标端点开关（Prometheus 文本格式，GET /metrics）。 */
  METRICS_ENABLED: z.enum(['0', '1']).default('1'),
  /** 非空时 /metrics 需要 `Authorization: Bearer <token>` 或 `?token=`。 */
  METRICS_TOKEN: z.string().default(''),
  /** 错误上报：off 不报、log 结构化打印、sentry 走注册的上报出口（未注册则降级为 log）。 */
  ERROR_REPORTING: z.enum(['off', 'log', 'sentry']).default('log'),
  /** Sentry DSN。**服务端不内置 SDK**，只把它透给 setErrorTransport() 注册的实现。 */
  SENTRY_DSN: z.string().default(''),
  SENTRY_ENVIRONMENT: z.string().default('production'),
  /** argon2id 参数（测试可调低以加速）。 */
  PASSWORD_MEMORY_COST: z.coerce.number().int().min(1024).default(65536),
  PASSWORD_TIME_COST: z.coerce.number().int().min(1).default(2),
});

export type Env = {
  writingHarnessEnabled: boolean;
  lunarouteApiKey: string;
  writingModel: string;
  writingHarnessStorage: string;
  writingConcurrency: number;
  writingRetentionHours: number;
  writingMemoryRetentionDays: number;
  writingMaxOutputTokens: number;
  writingReasoningTokens: number;
  writingReasoningEffort: 'low' | 'medium' | 'high';
  writingJsonMode: 'json_object' | 'json_schema';
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
  downloadUrl: string;
  logFormat: 'off' | 'text' | 'json';
  metricsEnabled: boolean;
  metricsToken: string;
  errorReporting: 'off' | 'log' | 'sentry';
  sentryDsn: string;
  sentryEnvironment: string;
};

function splitList(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const raw = EnvSchema.parse(source);
  if (raw.WRITING_HARNESS_ENABLED === '1' && !raw.LUNAROUTE_API_KEY.trim()) throw new Error('WRITING_HARNESS_ENABLED=1 requires LUNAROUTE_API_KEY on the server');
  if (raw.WRITING_HARNESS_ENABLED === '1' && raw.WRITING_HARNESS_STORAGE &&
      raw.WRITING_HARNESS_STORAGE !== raw.DATABASE_URL &&
      (raw.WRITING_HARNESS_STORAGE === ':memory:' || raw.DATABASE_URL === ':memory:' ||
       resolve(raw.WRITING_HARNESS_STORAGE) !== resolve(raw.DATABASE_URL)))
    throw new Error('Pi harness uses DATABASE_URL; separate WRITING_HARNESS_STORAGE is no longer supported');
  if (raw.WRITING_REASONING_TOKENS >= raw.WRITING_MAX_OUTPUT_TOKENS) throw new Error('WRITING_REASONING_TOKENS must be smaller than WRITING_MAX_OUTPUT_TOKENS');
  return {
    writingHarnessEnabled: raw.WRITING_HARNESS_ENABLED === '1',
    lunarouteApiKey: raw.LUNAROUTE_API_KEY,
    writingModel: raw.WRITING_MODEL,
    writingHarnessStorage: raw.WRITING_HARNESS_STORAGE || raw.DATABASE_URL,
    writingConcurrency: raw.WRITING_CONCURRENCY,
    writingRetentionHours: raw.WRITING_RETENTION_HOURS,
    writingMemoryRetentionDays: raw.WRITING_MEMORY_RETENTION_DAYS,
    writingMaxOutputTokens: raw.WRITING_MAX_OUTPUT_TOKENS,
    writingReasoningTokens: raw.WRITING_REASONING_TOKENS,
    writingReasoningEffort: raw.WRITING_REASONING_EFFORT,
    writingJsonMode: raw.WRITING_JSON_MODE,
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
    downloadUrl: raw.DOWNLOAD_URL,
    logFormat: raw.LOG_FORMAT,
    metricsEnabled: raw.METRICS_ENABLED === '1',
    metricsToken: raw.METRICS_TOKEN,
    errorReporting: raw.ERROR_REPORTING,
    sentryDsn: raw.SENTRY_DSN,
    sentryEnvironment: raw.SENTRY_ENVIRONMENT,
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
    // 测试默认不打访问日志、不报错误，否则 134 个用例会把终端刷满。
    logFormat: 'off',
    errorReporting: 'off',
    ...overrides,
  };
}
