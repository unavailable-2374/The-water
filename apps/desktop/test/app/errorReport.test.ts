import { describe, expect, it } from 'vitest';
import { errorMessageOf, errorStackOf, formatErrorReport } from '@/components/errorReport';
import { t } from '@/i18n';

const at = new Date('2026-09-04T00:00:00.000Z');

describe('errorMessageOf', () => {
  it('Error 取 message', () => {
    expect(errorMessageOf(new Error('炸了'))).toBe('炸了');
  });

  it('空 message 的 Error 退回 name', () => {
    expect(errorMessageOf(new TypeError(''))).toBe('TypeError');
  });

  it('字符串、带 message 的对象、其它值都能拿到点东西', () => {
    expect(errorMessageOf('坏了')).toBe('坏了');
    expect(errorMessageOf({ message: '接口 500' })).toBe('接口 500');
    expect(errorMessageOf({ code: 7 })).toBe('{"code":7}');
    // 兜底文案改成走词典（t.common.unknownError），这里跟着词典断言，别再写死字面量。
    expect(errorMessageOf(null)).toBe(t.common.unknownError);
    expect(errorMessageOf(undefined)).toBe(t.common.unknownError);
  });

  it('循环引用不会把自己搞崩', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(errorMessageOf(cyclic)).toBe('[object Object]');
  });
});

describe('errorStackOf', () => {
  it('有堆栈用堆栈', () => {
    const e = new Error('x');
    e.stack = 'Error: x\n    at foo';
    expect(errorStackOf(e)).toBe('Error: x\n    at foo');
  });

  it('没堆栈退回消息', () => {
    expect(errorStackOf('随手抛的字符串')).toBe('随手抛的字符串');
  });
});

describe('formatErrorReport', () => {
  it('按顺序列出时间、位置、路由、版本、环境，再跟堆栈', () => {
    const e = new Error('炸了');
    e.stack = 'Error: 炸了\n    at LibraryPage';
    expect(formatErrorReport({ error: e, scope: '书架', route: '#/library', appVersion: '0.1.0', userAgent: 'Tauri/2', at })).toBe([
      'The Water 错误报告',
      '时间：2026-09-04T00:00:00.000Z',
      '位置：书架',
      '路由：#/library',
      '版本：0.1.0',
      '环境：Tauri/2',
      '----',
      'Error: 炸了\n    at LibraryPage',
    ].join('\n'));
  });

  it('可选字段缺席时不留空行', () => {
    const out = formatErrorReport({ error: '坏了', at });
    expect(out).toBe('The Water 错误报告\n时间：2026-09-04T00:00:00.000Z\n----\n坏了');
  });

  it('组件栈单独成段，空白组件栈忽略', () => {
    expect(formatErrorReport({ error: 'x', at, componentStack: '\n    at A\n    at B' })).toContain('组件栈：\nat A\n    at B');
    expect(formatErrorReport({ error: 'x', at, componentStack: '   \n ' })).not.toContain('组件栈');
  });
});
