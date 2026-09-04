import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CSP_DIRECTIVES, buildCsp, buildDevCsp, mergeDirectives, serializeCsp } from '@/app/csp';

const conf = JSON.parse(readFileSync(fileURLToPath(new URL('../../src-tauri/tauri.conf.json', import.meta.url)), 'utf8')) as {
  app: { security: { csp: string; devCsp: string } };
};

describe('serializeCsp', () => {
  it('单空格分隔、分号加空格、无结尾分号', () => {
    expect(serializeCsp({ 'default-src': ["'self'"], 'object-src': ["'none'"] })).toBe("default-src 'self'; object-src 'none'");
  });

  it('没有源的指令只输出指令名', () => {
    expect(serializeCsp({ 'upgrade-insecure-requests': [] })).toBe('upgrade-insecure-requests');
  });

  it('输出能被 Tauri 的解析方式还原（split(";") + trim + split(" ")）', () => {
    const csp = buildCsp();
    const parsed = Object.fromEntries(csp.split(';').map((d) => {
      const [name, ...sources] = d.trim().split(' ');
      return [name, sources];
    }));
    // 不能解析出空指令，否则 Tauri 会往响应头里塞一条空的。
    expect(Object.keys(parsed)).not.toContain('');
    expect(parsed['default-src']).toEqual(["'self'"]);
    expect(Object.keys(parsed)).toEqual(Object.keys(CSP_DIRECTIVES));
  });

  it('每个源都不含空格、分号、换行', () => {
    for (const sources of Object.values(CSP_DIRECTIVES)) {
      for (const s of sources) expect(s).toMatch(/^[^\s;]+$/);
    }
  });
});

describe('mergeDirectives', () => {
  it('把额外的源追加到同名指令后并去重', () => {
    const merged = mergeDirectives({ 'connect-src': ["'self'"] }, { 'connect-src': ["'self'", 'ws://localhost:*'] });
    expect(merged['connect-src']).toEqual(["'self'", 'ws://localhost:*']);
  });

  it('额外指令不存在时直接新建', () => {
    expect(mergeDirectives({}, { 'worker-src': ['blob:'] })['worker-src']).toEqual(['blob:']);
  });
});

describe('实际放行的东西', () => {
  const c = CSP_DIRECTIVES;

  it('Tauri IPC 在两类平台上的形态都放行（否则 invoke 会退化成 postMessage）', () => {
    expect(c['connect-src']).toContain('ipc:');
    expect(c['connect-src']).toContain('http://ipc.localhost');
  });

  it('asset 协议同时进 connect-src 与 img-src（pdf.js 是 fetch 拉 PDF 的）', () => {
    for (const src of ['asset:', 'http://asset.localhost']) {
      expect(c['connect-src']).toContain(src);
      expect(c['img-src']).toContain(src);
    }
  });

  it('pdf.js 的 worker 与内嵌字体', () => {
    expect(c['worker-src']).toContain('blob:');
    expect(c['worker-src']).toContain("'self'");
    // pdf.js 用 @font-face { src: url(data:font/opentype;base64,…) } 注入字形
    expect(c['font-src']).toContain('data:');
    expect(c['script-src']).toContain("'wasm-unsafe-eval'");
  });

  it('用户可自填 Base URL：https 与本地回环都放行', () => {
    expect(c['connect-src']).toContain('https:');
    expect(c['connect-src']).toContain('http://localhost:*');
    expect(c['connect-src']).toContain('http://127.0.0.1:*');
  });

  it('依然堵死明文 http 到任意主机、内联脚本、eval、插件与内嵌框架', () => {
    expect(c['connect-src']).not.toContain('http:');
    expect(c['script-src']).not.toContain("'unsafe-inline'");
    expect(c['script-src']).not.toContain("'unsafe-eval'");
    expect(c['object-src']).toEqual(["'none'"]);
    expect(c['frame-ancestors']).toEqual(["'none'"]);
  });
});

describe('与 tauri.conf.json 保持同步', () => {
  it('csp 与 buildCsp() 逐字一致', () => {
    expect(conf.app.security.csp).toBe(buildCsp());
  });

  it('devCsp 与 buildDevCsp() 逐字一致', () => {
    expect(conf.app.security.devCsp).toBe(buildDevCsp());
  });

  it('开发态额外放行 vite 的 HMR websocket 与 react-refresh 的内联脚本', () => {
    const dev = buildDevCsp();
    expect(dev).toContain('ws://localhost:*');
    expect(dev).toContain("'unsafe-inline'");
  });
});
