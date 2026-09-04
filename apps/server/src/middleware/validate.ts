import type { Context, MiddlewareHandler } from 'hono';
import type { z } from 'zod';
import type { AppEnv } from '../context';
import { validation } from '../lib/errors';

type Target = 'json' | 'query' | 'param';

export type Validated = {
  json: unknown;
  query: unknown;
  param: unknown;
};

declare module 'hono' {
  interface ContextVariableMap {
    validated: Partial<Validated>;
  }
}

function issuesToDetails(issues: z.core.$ZodIssue[]): Record<string, unknown> {
  return {
    issues: issues.slice(0, 20).map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
  };
}

/** 极简 zod 校验中间件：失败抛 VALIDATION_ERROR，成功后通过 getValid() 取值。 */
export function validate<T extends z.ZodTypeAny>(target: Target, schema: T): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    let input: unknown;
    if (target === 'json') {
      const ct = c.req.header('content-type') ?? '';
      if (!ct.includes('application/json')) throw validation('Content-Type 必须为 application/json');
      try {
        input = await c.req.json();
      } catch {
        throw validation('JSON 解析失败');
      }
    } else if (target === 'query') {
      input = c.req.query();
    } else {
      input = c.req.param();
    }
    const result = schema.safeParse(input);
    if (!result.success) throw validation('请求参数无效', issuesToDetails(result.error.issues));
    const prev = (c.get('validated') as Partial<Validated> | undefined) ?? {};
    c.set('validated', { ...prev, [target]: result.data });
    await next();
  };
}

export function getValid<T>(c: Context<AppEnv>, target: Target): T {
  const v = (c.get('validated') as Partial<Validated> | undefined)?.[target];
  return v as T;
}
