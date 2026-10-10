import { Hono } from 'hono';
import { HarnessRequestSchema, type HarnessRequest } from '@the-water/shared';
import type { AppDeps, AppEnv } from '../../context';
import { ApiError, validation, forbidden } from '../../lib/errors';
import { requireAuth } from '../../middleware/auth';
import { validate, getValid } from '../../middleware/validate';

export function writingRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use('/writing/*', requireAuth());
  app.get('/writing/capabilities', c => c.json(deps.writingHarness?.capabilities() ?? {
    enabled: false, engine: 'pi', protocolVersion: 1, provider: 'lunaroute', model: deps.env.writingModel,
    contextWindow: 1048576, maxOutputTokens: deps.env.writingMaxOutputTokens, reasoningTokens: deps.env.writingReasoningTokens,
    reasoningEffort: deps.env.writingReasoningEffort, jsonMode: deps.env.writingJsonMode, retentionHours: deps.env.writingRetentionHours,
  }));
  app.use('/writing/tasks*', async (c, next) => {
    if (!c.get('user')?.emailVerifiedAt) throw forbidden('请先验证邮箱再使用模型服务');
    return next();
  });
  const harness = () => {
    if (!deps.writingHarness) throw new ApiError('INTERNAL', '开发者尚未配置模型服务');
    return deps.writingHarness;
  };
  app.post('/writing/tasks', validate('json', HarnessRequestSchema), async c => {
    const task = await harness().create(c.get('user')!.id, c.req.header('Idempotency-Key') ?? '', getValid<HarnessRequest>(c, 'json'));
    return c.json(task, 202);
  });
  app.get('/writing/tasks/:id', c => {
    const after = Number(c.req.query('after') ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw validation('after 必须为非负整数');
    return c.json(harness().page(c.get('user')!.id, c.req.param('id'), after));
  });
  app.delete('/writing/tasks/:id', c => c.json(harness().cancel(c.get('user')!.id, c.req.param('id'))));
  return app;
}
