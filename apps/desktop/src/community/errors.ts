import { ApiError, describeError } from '@/sync/api';

/** 把服务端错误码翻译成温和的中文提示；未知错误退回原始描述。 */
export function friendlyError(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'BLOCKED':
        return '你们之间设置了屏蔽，暂时不能这样做。';
      case 'HANDLE_TAKEN':
        return '这个用户名已经有人用了，换一个吧。';
      case 'UNAUTHORIZED':
        return '登录已过期，请重新登录。';
      case 'RATE_LIMITED':
        return '慢一点，过一会儿再试。';
      case 'VALIDATION_ERROR':
        return e.message || '内容不太对，检查一下再试。';
      default:
        return e.message;
    }
  }
  return describeError(e);
}

/** 需要重新登录的错误（调用方据此弹登录框）。 */
export function needsLogin(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'UNAUTHORIZED';
}
