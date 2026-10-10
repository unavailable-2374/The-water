import { sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { HealthCheck, HealthResponse, ReadinessResponse } from '@the-water/shared';
import type { AppDeps, AppEnv } from './context';
import { syncNovelsFtsIfPending } from './db/fts';
import { ApiError } from './lib/errors';
import { Metrics } from './lib/metrics';
import { createErrorReporter } from './lib/reporting';
import { authenticate } from './middleware/auth';
import { clientId } from './middleware/client-id';
import { errorToResponse } from './middleware/error-handler';
import { observability } from './middleware/observability';
import { keyByIp, rateLimit } from './middleware/rate-limit';
import { requestId } from './middleware/request-id';
import { adminRoutes } from './modules/admin/routes';
import { authRoutes } from './modules/auth/routes';
import { blobRoutes } from './modules/blobs/routes';
import { browseRoutes } from './modules/browse/routes';
import { commentRoutes } from './modules/comments/routes';
import { feedRoutes } from './modules/feed/routes';
import { forkRoutes } from './modules/forks/routes';
import { incentiveRoutes } from './modules/incentive/routes';
import { notificationRoutes } from './modules/notifications/routes';
import { novelRoutes } from './modules/novels/routes';
import { socialRoutes } from './modules/social/routes';
import { userRoutes } from './modules/users/routes';
import { versionRoutes } from './modules/versions/routes';
import { webRoutes } from './web/routes';
import { writingRoutes } from './modules/writing/routes';

export const SERVICE_NAME = 'the-water-server';
export const SERVICE_VERSION = '0.1.0';

export const DEFAULT_ORIGINS = ['tauri://localhost', 'http://tauri.localhost', 'http://localhost:1420'];

export const BODY_LIMITS = {
  default: 256 * 1024,
  versions: 18 * 1024 * 1024,
  blobs: 4 * 1024 * 1024,
  writing: 2 * 1024 * 1024,
} as const;

const tooLarge = () => {
  throw new ApiError('PAYLOAD_TOO_LARGE', '请求体过大');
};

function bodyLimitFor(path: string): number {
  if (path === '/api/v1/writing/tasks') return BODY_LIMITS.writing;
  if (path === '/api/v1/blobs') return BODY_LIMITS.blobs;
  if (/^\/api\/v1\/novels\/[^/]+\/versions\/?$/.test(path)) return BODY_LIMITS.versions;
  return BODY_LIMITS.default;
}

/** DB 探活：一条最便宜的查询，锁死 / 文件被删 / 权限丢失都会在这里现形。 */
function probeDb(deps: AppDeps): HealthCheck {
  const t0 = performance.now();
  try {
    deps.db.all(sql`SELECT 1`);
    return { name: 'db', ok: true, latencyMs: Math.round((performance.now() - t0) * 1000) / 1000 };
  } catch (e) {
    return {
      name: 'db',
      ok: false,
      latencyMs: Math.round((performance.now() - t0) * 1000) / 1000,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const metrics = new Metrics();
  const reporter = createErrorReporter(deps.env);

  app.use(requestId());
  app.use(observability(deps.env, { metrics }));
  app.use(clientId(deps.env));
  // 搜索前排空 FTS 重建队列：队列由 novels 上的触发器写，空队列时代价是一次 LIMIT 1 查询。
  app.use(async (c, next) => {
    if (c.req.method === 'GET' && c.req.query('q')) {
      try {
        syncNovelsFtsIfPending(deps.db);
      } catch {
        /* 索引同步失败不该挡住搜索，db/fts.ts 内部已降级到 LIKE */
      }
    }
    return next();
  });
  app.onError((err, c) => {
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/health')) return errorToResponse(err, c, reporter);
    // 网页路由：极简中文错误页。
    if (err instanceof ApiError) return c.text(`${err.status} ${err.message}`, err.status as 404);
    if (err instanceof HTTPException) return c.text(`${err.status} 出错了`, err.status as 404);
    console.error(`[${c.get('requestId')}] 网页渲染错误:`, err);
    reporter.capture({ error: err, requestId: c.get('requestId'), method: c.req.method, path: c.req.path, status: 500 });
    return c.text('500 服务器内部错误', 500);
  });
  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) return errorToResponse(new ApiError('NOT_FOUND', '接口不存在'), c);
    return c.text('404 页面不存在', 404);
  });

  /**
   * 存活 + 就绪合一：DB 探活通过时返回原样的 `HealthResponse`（契约不变），
   * 探不通则 503 + `ReadinessResponse`，让 LB 把这个实例摘掉。
   * 从前这里不碰数据库，库锁死时依然返绿（§4.3）。
   */
  const health = (c: Context<AppEnv>) => {
    const checks = [probeDb(deps)];
    const time = deps.clock.now().toISOString();
    if (checks.every((x) => x.ok)) {
      const body: HealthResponse = { ok: true, service: SERVICE_NAME, version: SERVICE_VERSION, time };
      return c.json(body);
    }
    const body: ReadinessResponse = { ok: false, service: SERVICE_NAME, version: SERVICE_VERSION, time, checks };
    return c.json(body, 503);
  };
  /** 就绪检查：无论通过与否都带上每项检查的明细，给运维看。 */
  const ready = (c: Context<AppEnv>) => {
    const checks = [probeDb(deps)];
    const ok = checks.every((x) => x.ok);
    const body: ReadinessResponse = { ok, service: SERVICE_NAME, version: SERVICE_VERSION, time: deps.clock.now().toISOString(), checks };
    return c.json(body, ok ? 200 : 503);
  };
  app.get('/health', health);
  app.get('/health/ready', ready);

  // 指标端点。默认开着（内网），设了 METRICS_TOKEN 就要带 token 才能读。
  if (deps.env.metricsEnabled) {
    app.get('/metrics', (c) => {
      const want = deps.env.metricsToken;
      if (want) {
        const got = c.req.query('token') ?? (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
        if (got !== want) throw new ApiError('UNAUTHORIZED', '需要 metrics token');
      }
      return c.text(metrics.render(deps.clock.now().getTime()), 200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    });
  }

  const api = new Hono<AppEnv>();
  api.use(
    '*',
    cors({
      origin: [...DEFAULT_ORIGINS, ...deps.env.extraOrigins],
      allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Client-Id', 'X-Request-Id'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      exposeHeaders: ['X-Request-Id', 'Retry-After'],
      maxAge: 600,
    }),
  );
  api.use('*', compress());
  api.use('*', async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return next();
    return bodyLimit({ maxSize: bodyLimitFor(c.req.path), onError: tooLarge })(c, next);
  });
  api.use('*', authenticate(deps));
  const readLimit = rateLimit(deps, 'read', keyByIp);
  api.use('*', async (c, next) => (c.req.method === 'GET' ? readLimit(c, next) : next()));

  api.get('/health', health);
  api.get('/health/ready', ready);
  api.route('/', authRoutes(deps));
  api.route('/', browseRoutes(deps));
  api.route('/', novelRoutes(deps));
  api.route('/', versionRoutes(deps));
  api.route('/', blobRoutes(deps));
  api.route('/', forkRoutes(deps));
  api.route('/', socialRoutes(deps));
  api.route('/', userRoutes(deps));
  api.route('/', feedRoutes(deps));
  api.route('/', commentRoutes(deps));
  api.route('/', incentiveRoutes(deps));
  api.route('/', notificationRoutes(deps));
  api.route('/', adminRoutes(deps));
  api.route('/', writingRoutes(deps));
  api.get('/capabilities', c => c.json({ bundleVersions: [1, 2], storyGraphVersion: 1, creationMaterials: { version: 1, blockBytes: 262144, totalBytes: 16777216 } }));
  app.route('/api/v1', api);

  app.route('/', webRoutes(deps));
  return app;
}

export type App = ReturnType<typeof createApp>;
