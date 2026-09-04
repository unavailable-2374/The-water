import { t } from '@/i18n';

/** 错误详情文本：错误边界里「反馈」按钮复制的就是这一段。纯函数，方便测。 */

export interface ErrorReportInput {
  error: unknown;
  /** 出错的位置，如「书架」「根应用」。 */
  scope?: string;
  /** 出错时的路由（hash 路由取 location.hash）。 */
  route?: string;
  /** 应用版本号。 */
  appVersion?: string;
  /** React 的组件栈（componentDidCatch 第二个参数）。 */
  componentStack?: string | null;
  /** 发生时间，默认取当前时刻；测试里传固定值。 */
  at?: Date;
  /** UA 字符串，用于区分平台。 */
  userAgent?: string;
}

/**
 * 从任意抛出物里取一句人能读的错误信息。
 *
 * 注意：下面 `formatErrorReport` 拼出来的报告体是**给开发者看的诊断载荷**，
 * 字段名刻意固定成中文、不跟界面语言走 —— 用户把它复制发过来时，
 * 我们希望每份报告的格式都一样，而不是随他当时的界面语言变。
 */
export function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || t.common.unknownError;
  if (typeof error === 'string') return error || t.common.unknownError;
  if (error && typeof error === 'object') {
    const msg = (error as { message?: unknown }).message;
    if (typeof msg === 'string' && msg) return msg;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error ?? t.common.unknownError);
}

/** 取堆栈；没有堆栈就退回消息本身。 */
export function errorStackOf(error: unknown): string {
  if (error instanceof Error && error.stack) return error.stack;
  return errorMessageOf(error);
}

/** 组装成一段可以直接粘给我们的纯文本。 */
export function formatErrorReport(input: ErrorReportInput): string {
  const lines = [
    'The Water 错误报告',
    `时间：${(input.at ?? new Date()).toISOString()}`,
  ];
  if (input.scope) lines.push(`位置：${input.scope}`);
  if (input.route) lines.push(`路由：${input.route}`);
  if (input.appVersion) lines.push(`版本：${input.appVersion}`);
  if (input.userAgent) lines.push(`环境：${input.userAgent}`);
  lines.push('----');
  lines.push(errorStackOf(input.error));
  const stack = input.componentStack?.trim();
  if (stack) {
    lines.push('----');
    lines.push('组件栈：');
    lines.push(stack);
  }
  return lines.join('\n');
}
