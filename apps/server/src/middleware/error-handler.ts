import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ApiErrorBody } from '@the-water/shared';
import type { AppEnv } from '../context';
import { ApiError } from '../lib/errors';
import type { ErrorReporter } from '../lib/reporting';

export function errorToResponse(err: unknown, c: Context<AppEnv>, reporter?: ErrorReporter): Response {
  const requestId = c.get('requestId');
  let apiErr: ApiError;
  if (err instanceof ApiError) {
    apiErr = err;
  } else if (err instanceof HTTPException) {
    if (err.status === 413) apiErr = new ApiError('PAYLOAD_TOO_LARGE', '请求体过大');
    else if (err.status === 401) apiErr = new ApiError('UNAUTHORIZED', '需要登录');
    else if (err.status === 404) apiErr = new ApiError('NOT_FOUND', '资源不存在');
    else if (err.status === 400) apiErr = new ApiError('VALIDATION_ERROR', err.message || '请求无效');
    else apiErr = new ApiError('INTERNAL', '服务器内部错误');
  } else if (err instanceof SyntaxError) {
    apiErr = new ApiError('VALIDATION_ERROR', 'JSON 解析失败');
  } else {
    console.error(`[${requestId}] 未处理错误:`, err);
    apiErr = new ApiError('INTERNAL', '服务器内部错误');
  }
  // 只上报 5xx：4xx 是客户端自己的问题，报上去只会把告警淹掉。
  if (reporter && apiErr.status >= 500) {
    reporter.capture({
      error: err,
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: apiErr.status,
      userId: c.get('user')?.id ?? null,
    });
  }
  const body: ApiErrorBody = apiErr.toBody();
  if (requestId) c.header('X-Request-Id', requestId);
  return c.json(body, apiErr.status as ContentfulStatusCode);
}
