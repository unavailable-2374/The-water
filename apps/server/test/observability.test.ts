/**
 * §4.3 服务端可观测性：结构化请求日志、/health 探 DB、指标端点、错误上报预留。
 */
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { HealthResponseSchema, ReadinessResponseSchema } from '@the-water/shared';
import { createApp } from '../src/app';
import type { AppDeps, AppEnv } from '../src/context';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { testEnv, type Env } from '../src/env';
import { ApiError } from '../src/lib/errors';
import { memoryMailer } from '../src/lib/mailer';
import { Metrics } from '../src/lib/metrics';
import { noopModerator } from '../src/lib/moderation';
import { createErrorReporter, resetReporterWarningForTest, setErrorTransport, type ErrorReport } from '../src/lib/reporting';
import { FakeClock } from '../src/lib/time';
import { observability } from '../src/middleware/observability';
import { expectSchema, makeTestApp } from './helpers';

/** 直接拿到底层 sqlite 句柄，才能制造「数据库不可用」。 */
function appWithRawDb(env: Partial<Env> = {}) {
  const { db, sqlite } = createDb(':memory:');
  runMigrations(db);
  const deps: AppDeps = {
    db,
    env: testEnv(env),
    clock: new FakeClock(),
    moderator: noopModerator,
    mailer: memoryMailer(),
    rateLimits: false,
  };
  return { app: createApp(deps), sqlite };
}

describe('健康检查探 DB', () => {
  it('/health 正常时形状不变，/health/ready 带检查明细', async () => {
    const t = makeTestApp();
    const h = await t.json('GET', '/health');
    expect(h.status).toBe(200);
    expectSchema(HealthResponseSchema, h.body);

    const r = await t.json('GET', '/health/ready');
    expect(r.status).toBe(200);
    const ready = expectSchema(ReadinessResponseSchema, r.body);
    expect(ready.ok).toBe(true);
    expect(ready.checks.map((c) => c.name)).toEqual(['db']);
    // /api/v1 下也挂了一份，给同一套探针用。
    expect((await t.json('GET', '/api/v1/health/ready')).status).toBe(200);
  });

  it('数据库不可用时 /health 变红（从前锁死也返绿）', async () => {
    const { app, sqlite } = appWithRawDb();
    expect((await app.request('/health')).status).toBe(200);
    sqlite.close();

    const res = await app.request('/health');
    expect(res.status).toBe(503);
    const body = expectSchema(ReadinessResponseSchema, await res.json());
    expect(body.ok).toBe(false);
    expect(body.checks[0]!.ok).toBe(false);
    expect(body.checks[0]!.error).toBeTruthy();

    const ready = await app.request('/health/ready');
    expect(ready.status).toBe(503);
  });
});

describe('结构化请求日志', () => {
  const runOnce = async (env: Env, path = '/ok') => {
    const lines: string[] = [];
    const app = new Hono<AppEnv>();
    app.use(observability(env, { sink: (l) => lines.push(l) }));
    app.get('/ok', (c) => c.text('ok'));
    app.get('/boom', () => {
      throw new ApiError('NOT_FOUND', '没有');
    });
    app.onError((e, c) => c.text('err', e instanceof ApiError ? (e.status as 404) : 500));
    await app.request(path);
    return lines;
  };

  it('json 格式输出一行 JSON，含方法 / 路径 / 状态码 / 延迟 / requestId', async () => {
    const [line] = await runOnce(testEnv({ logFormat: 'json' }));
    const rec = JSON.parse(line!);
    expect(rec.method).toBe('GET');
    expect(rec.path).toBe('/ok');
    expect(rec.route).toBe('/ok');
    expect(rec.status).toBe(200);
    expect(typeof rec.durationMs).toBe('number');
    expect(rec).toHaveProperty('requestId');
    expect(rec).toHaveProperty('userId');
    expect(rec.level).toBe('info');
  });

  it('text 格式人读，off 完全不打', async () => {
    const [line] = await runOnce(testEnv({ logFormat: 'text' }));
    expect(line).toContain('GET /ok 200');
    expect(await runOnce(testEnv({ logFormat: 'off' }))).toEqual([]);
  });

  it('处理链抛错时也记一条，状态码取自错误', async () => {
    const [line] = await runOnce(testEnv({ logFormat: 'json' }), '/boom');
    const rec = JSON.parse(line!);
    expect(rec.status).toBe(404);
    expect(rec.level).toBe('warn');
  });
});

describe('指标端点', () => {
  it('输出 Prometheus 文本：请求量、状态码、延迟分布', async () => {
    const t = makeTestApp();
    await t.json('GET', '/api/v1/novels');
    await t.json('GET', '/api/v1/novels');
    await t.json('GET', '/api/v1/novels/does-not-exist');

    const res = await t.request('GET', '/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('# TYPE http_requests_total counter');
    // 路由用模板而不是真实路径，否则每个 id 都是一条新时间序列。
    expect(body).toContain('http_requests_total{method="GET",route="/api/v1/novels",status="200"} 2');
    expect(body).toContain('route="/api/v1/novels/:id",status="404"');
    expect(body).not.toContain('does-not-exist');
    expect(body).toContain('# TYPE http_request_duration_seconds histogram');
    expect(body).toContain('http_request_duration_seconds_bucket{method="GET",route="/api/v1/novels",le="+Inf"} 2');
    expect(body).toContain('http_requests_in_flight');
  });

  it('未匹配路由归到 <unmatched>，不会让基数爆掉', async () => {
    const t = makeTestApp();
    await t.request('GET', '/no/such/path/1');
    await t.request('GET', '/no/such/path/2');
    const body = await (await t.request('GET', '/metrics')).text();
    expect(body).toContain('route="<unmatched>"');
    expect(body).not.toContain('/no/such/path');
  });

  it('METRICS_TOKEN 生效，METRICS_ENABLED=0 时端点消失', async () => {
    const guarded = makeTestApp({ env: { metricsToken: 'sekret' } });
    expect((await guarded.request('GET', '/metrics')).status).toBe(401);
    expect((await guarded.request('GET', '/metrics?token=sekret')).status).toBe(200);
    expect((await guarded.request('GET', '/metrics', { headers: { Authorization: 'Bearer sekret' } })).status).toBe(200);

    const off = makeTestApp({ env: { metricsEnabled: false } });
    expect((await off.request('GET', '/metrics')).status).toBe(404);
  });

  it('直方图按 le 累计，桶是单调不减的', () => {
    const m = new Metrics();
    m.observe('GET', '/x', 200, 0.002);
    m.observe('GET', '/x', 200, 0.4);
    m.observe('GET', '/x', 500, 30);
    const text = m.render(Date.now());
    expect(text).toContain('http_request_duration_seconds_bucket{method="GET",route="/x",le="0.005"} 1');
    expect(text).toContain('http_request_duration_seconds_bucket{method="GET",route="/x",le="0.5"} 2');
    expect(text).toContain('http_request_duration_seconds_bucket{method="GET",route="/x",le="+Inf"} 3');
    expect(text).toContain('http_request_duration_seconds_count{method="GET",route="/x"} 3');
    expect(m.snapshot()).toEqual({ requests: 3, inFlight: 0, series: 1 });
  });
});

describe('错误上报预留', () => {
  it('off 不报，log 打结构化一行', () => {
    const lines: string[] = [];
    const off = createErrorReporter(testEnv({ errorReporting: 'off' }), (l) => lines.push(l));
    off.capture({ error: new Error('x') });
    expect(lines).toEqual([]);

    const log = createErrorReporter(testEnv({ errorReporting: 'log' }), (l) => lines.push(l));
    log.capture({ error: new Error('炸了'), requestId: 'req1', path: '/api/v1/novels', status: 500 });
    const rec = JSON.parse(lines[0]!);
    expect(rec.kind).toBe('error-report');
    expect(rec.message).toBe('炸了');
    expect(rec.requestId).toBe('req1');
  });

  it('sentry 模式走注册的出口；没注册时降级为打印且只告警一次', () => {
    const got: ErrorReport[] = [];
    const lines: string[] = [];
    const env = testEnv({ errorReporting: 'sentry', sentryDsn: 'https://example/1' });

    resetReporterWarningForTest();
    const noSdk = createErrorReporter(env, (l) => lines.push(l));
    noSdk.capture({ error: new Error('a') });
    noSdk.capture({ error: new Error('b') });
    expect(lines.filter((l) => l.includes('没有注册上报出口')).length).toBe(1);
    expect(lines.filter((l) => l.includes('"kind":"error-report"')).length).toBe(2);

    setErrorTransport((r) => got.push(r));
    try {
      createErrorReporter(env, (l) => lines.push(l)).capture({ error: new Error('c'), requestId: 'r' });
      expect(got.length).toBe(1);
      expect(got[0]!.requestId).toBe('r');
    } finally {
      setErrorTransport(null);
      resetReporterWarningForTest();
    }
  });

  it('5xx 才上报，4xx 不打扰', async () => {
    const got: ErrorReport[] = [];
    setErrorTransport((r) => got.push(r));
    try {
      const t = makeTestApp({ env: { errorReporting: 'sentry' } });
      await t.json('GET', '/api/v1/novels/does-not-exist');
      expect(got.length).toBe(0);
    } finally {
      setErrorTransport(null);
    }
  });
});
