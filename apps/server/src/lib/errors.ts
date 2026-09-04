import { ERROR_STATUS, type ApiErrorBody, type ErrorCode } from '@the-water/shared';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }

  toBody(): ApiErrorBody {
    const error: ApiErrorBody['error'] = { code: this.code, message: this.message };
    if (this.details) error.details = this.details;
    return { error };
  }
}

export const notFound = (what = '资源') => new ApiError('NOT_FOUND', `${what}不存在`);
export const unauthorized = (message = '需要登录') => new ApiError('UNAUTHORIZED', message);
export const forbidden = (message = '没有权限') => new ApiError('FORBIDDEN', message);
export const validation = (message: string, details?: Record<string, unknown>) =>
  new ApiError('VALIDATION_ERROR', message, details);
export const conflict = (message: string, details?: Record<string, unknown>) =>
  new ApiError('CONFLICT', message, details);
