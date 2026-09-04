import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { HealthResponse } from '@the-water/shared';
import type { AppDeps, AppEnv } from './context';
import { ApiError } from './lib/errors';
import { authenticate } from './middleware/auth';
import { clientId } from './middleware/client-id';
import { errorToResponse } from './middleware/error-handler';
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
import { novelRoutes } from './modules/novels/routes';
import { socialRoutes } from './modules/social/routes';
import { userRoutes } from './modules/users/routes';
import { versionRoutes } from './modules/versions/routes';
import { webRoutes } from './web/routes';

export const SERVICE_NAME = 'the-water-server';
export const SERVICE_VERSION = '0.1.0';

export const DEFAULT_ORIGINS = ['tauri://localhost', 'http://tauri.localhost', 'http://localhost:1420'];

export const BODY_LIMITS = {
  default: 256 * 1024,
  versions: 1_536 * 1024,
  blobs: 4 * 1024 * 1024,
} as const;

const tooLarge = () => {
  throw new ApiError('PAYLOAD_TOO_LARGE', '请求体过大');
};

function bodyLimitFor(path: string): number {
  if (path === '/api/v1/blobs') return BODY_LIMITS.blobs;
  if (/^\/api\/v1\/novels\/[^/]+\/versions\/?$/.test(path)) return BODY_LIMITS.versions;
  return BODY_LIMITS.default;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.use(requestId());
  app.use(clientId(deps.env));
  app.onError((err, c) => {
    if (c.req.path.startsWith('/api/') || c.req.path === '/health') return errorToResponse(err, c);
    // 网页路由：极简中文错误页。
    if (err instanceof ApiError) return c.text(`${err.status} ${err.message}`, err.status as 404);
    if (err instanceof HTTPException) return c.text(`${err.status} 出错了`, err.status as 404);
    console.error(`[${c.get('requestId')}] 网页渲染错误:`, err);
    return c.text('500 服务器内部错误', 500);
  });
  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) return errorToResponse(new ApiError('NOT_FOUND', '接口不存在'), c);
    return c.text('404 页面不存在', 404);
  });

  const health = (c: Context<AppEnv>) => {
    const body: HealthResponse = { ok: true, service: SERVICE_NAME, version: SERVICE_VERSION, time: deps.clock.now().toISOString() };
    return c.json(body);
  };
  app.get('/health', health);

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
  api.route('/', adminRoutes(deps));
  app.route('/api/v1', api);

  app.route('/', webRoutes(deps));
  return app;
}

export type App = ReturnType<typeof createApp>;
