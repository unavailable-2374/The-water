import { describe, expect, it } from 'vitest';
import {
  RUNTIME_DEFAULTS, formatHeaders, msToSeconds, parseHeaders, secondsToMs,
  validateBaseUrl, validateProxyUrl, validateRuntimeFields,
} from '@/features/settings/providerAdvanced';

describe('parseHeaders', () => {
  it('一行一条，冒号后的空格会去掉', () => {
    expect(parseHeaders('X-A: 1\nX-B:2').headers).toEqual({ 'X-A': '1', 'X-B': '2' });
  });

  it('空行与 # 注释行忽略', () => {
    const r = parseHeaders('\n# 注释\nX-A: 1\n   \n');
    expect(r.headers).toEqual({ 'X-A': '1' });
    expect(r.errors).toEqual([]);
  });

  it('值里可以带冒号（只按第一个冒号切）', () => {
    expect(parseHeaders('Referer: https://a.com:8080/x').headers).toEqual({ Referer: 'https://a.com:8080/x' });
  });

  it('值允许为空', () => {
    expect(parseHeaders('X-A:').headers).toEqual({ 'X-A': '' });
  });

  it('缺冒号、冒号开头、名称非法都报错且不落进结果', () => {
    const r = parseHeaders('没有冒号\n: 值\nBad Name: 1\nX-Ok: 2');
    expect(r.headers).toEqual({ 'X-Ok': '2' });
    expect(r.errors).toHaveLength(3);
  });
});

describe('formatHeaders', () => {
  it('对象转回一行一条', () => {
    expect(formatHeaders({ 'X-A': '1', 'X-B': '2' })).toBe('X-A: 1\nX-B: 2');
  });

  it('空 / null 得到空串', () => {
    expect(formatHeaders({})).toBe('');
    expect(formatHeaders(null)).toBe('');
    expect(formatHeaders(undefined)).toBe('');
  });

  it('和 parseHeaders 互为逆运算', () => {
    const headers = { 'X-Gateway-Token': 'abc', 'HTTP-Referer': 'https://example.com' };
    expect(parseHeaders(formatHeaders(headers)).headers).toEqual(headers);
  });
});

describe('validateProxyUrl', () => {
  it('留空表示直连', () => {
    expect(validateProxyUrl('')).toBeNull();
    expect(validateProxyUrl('   ')).toBeNull();
  });

  it('http / https / socks5 都行', () => {
    for (const url of ['http://127.0.0.1:7890', 'https://proxy.local:443', 'socks5://127.0.0.1:1080', 'socks5h://h:1080']) {
      expect(validateProxyUrl(url)).toBeNull();
    }
  });

  it('不是完整地址、协议不支持都要报错', () => {
    expect(validateProxyUrl('127.0.0.1:7890')).toBeTruthy();
    expect(validateProxyUrl('ftp://a.com')).toBeTruthy();
  });
});

describe('validateBaseUrl', () => {
  it('必须是 http/https 绝对地址', () => {
    expect(validateBaseUrl('https://api.deepseek.com')).toBeNull();
    expect(validateBaseUrl('http://localhost:11434/v1')).toBeNull();
  });

  it('空、相对路径、别的协议都报错', () => {
    expect(validateBaseUrl('')).toBeTruthy();
    expect(validateBaseUrl('api.deepseek.com')).toBeTruthy();
    expect(validateBaseUrl('file:///etc/passwd')).toBeTruthy();
  });
});

describe('validateRuntimeFields', () => {
  it('默认值合法', () => {
    expect(validateRuntimeFields(RUNTIME_DEFAULTS)).toEqual([]);
  });

  it('超时低于 5 秒或高于 600 秒都不行', () => {
    expect(validateRuntimeFields({ ...RUNTIME_DEFAULTS, firstByteTimeoutMs: 1000 })).toHaveLength(1);
    expect(validateRuntimeFields({ ...RUNTIME_DEFAULTS, idleTimeoutMs: 600001 })).toHaveLength(1);
    expect(validateRuntimeFields({ ...RUNTIME_DEFAULTS, firstByteTimeoutMs: 5000, idleTimeoutMs: 600000 })).toEqual([]);
  });

  it('非整数 / NaN 也拦下来', () => {
    expect(validateRuntimeFields({ ...RUNTIME_DEFAULTS, firstByteTimeoutMs: Number.NaN })).toHaveLength(1);
    expect(validateRuntimeFields({ ...RUNTIME_DEFAULTS, idleTimeoutMs: 6000.5 })).toHaveLength(1);
  });

  it('并发只能是 1–16', () => {
    expect(validateRuntimeFields({ ...RUNTIME_DEFAULTS, concurrency: 0 })).toHaveLength(1);
    expect(validateRuntimeFields({ ...RUNTIME_DEFAULTS, concurrency: 17 })).toHaveLength(1);
    expect(validateRuntimeFields({ ...RUNTIME_DEFAULTS, concurrency: 16 })).toEqual([]);
  });

  it('多个问题一次全报出来', () => {
    expect(validateRuntimeFields({ firstByteTimeoutMs: 0, idleTimeoutMs: 0, proxyUrl: '不是地址', concurrency: 0 })).toHaveLength(4);
  });
});

describe('秒与毫秒', () => {
  it('来回换算', () => {
    expect(secondsToMs(60)).toBe(60000);
    expect(msToSeconds(90000)).toBe(90);
    expect(msToSeconds(secondsToMs(45))).toBe(45);
  });
});
