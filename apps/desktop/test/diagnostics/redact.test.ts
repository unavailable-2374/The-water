import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { REDACTED, looksLikeSecretToken, maskId, redactHeaders, redactJson, redactText, redactUrl } from '@/diagnostics/redact';
import { buildDiagnosticsFiles, diagnosticsFileName, redactProvider, safeLogName, type DiagnosticsInput } from '@/diagnostics/collect';
import { zipDiagnostics } from '@/diagnostics/bundle';
import { MAX_RECENT_ERRORS, clearRecentErrors, recentErrors, recordError } from '@/diagnostics/recentErrors';

/** 这些字符串一旦出现在诊断包里就是事故。 */
const SECRETS = {
  openai: 'sk-proj-Ab3xY9zQ1mN7pL2kR8sT4vW6dF0gH5jK',
  deepseek: 'sk-1234567890abcdef1234567890abcdef',
  bearer: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.QWERtyU8ioPlKjHgFdSaZxCvBnM1234',
  header: 'X7kQm2Rv9TzL4pN8sD1fG6hJ3wY5bC0e',
  proxyPassword: 'hunter2SuperSecret',
  queryKey: 'QzT8vN2mK9pL4rX7sB1dW6yH3fG5jA0c',
  envKey: 'sk-envLeakedFromAnErrorMessage12345',
  google: 'AIzaSyD9xK2mQ7pL4vN8sT1rB6wY3fH5jG0dCe',
  github: 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
};

function input(): DiagnosticsInput {
  return {
    at: new Date('2026-09-04T10:30:00Z'),
    app: { version: '0.1.0', tauriVersion: '2.11.0', platform: 'macos', arch: 'aarch64', osVersion: '15.1' },
    dirs: { data: '/Users/somebody/Library/Application Support/com.thewater.desktop', log: '/Users/somebody/Library/Logs/com.thewater.desktop' },
    runtime: { userAgent: 'Mozilla/5.0 (Macintosh)', language: 'zh-CN', screen: '1512×982 @2x', online: true },
    settings: {
      theme: 'dark',
      autoResumeJobs: true,
      clientId: 'cli_0123456789abcdef',
      // 设置里不该有密钥，但真出现了也必须打掉
      apiKey: SECRETS.deepseek,
      nested: { accessToken: SECRETS.bearer },
    },
    providers: [
      {
        id: 'p1',
        name: 'DeepSeek',
        kind: 'openai',
        model: 'deepseek-chat',
        baseUrl: `https://api.deepseek.com/v1?api_key=${SECRETS.queryKey}`,
        extraHeaders: { Authorization: `Bearer ${SECRETS.header}`, 'X-Trace': 'on' },
        secretRef: 'provider:p1',
        proxyUrl: `http://alice:${SECRETS.proxyPassword}@proxy.local:8080`,
        concurrency: 2,
        isDefault: true,
      },
      {
        id: 'p2',
        name: 'OpenAI',
        kind: 'openai',
        model: 'gpt-4o',
        baseUrl: 'https://api.openai.com/v1',
        extraHeaders: { 'x-api-key': SECRETS.openai },
        secretRef: 'env:OPENAI_API_KEY',
      },
    ],
    errors: [
      {
        at: Date.parse('2026-09-04T10:29:00Z'),
        scope: '写作',
        message: `401 Unauthorized，请求头 authorization=${SECRETS.bearer}`,
        stack: `Error: 401\n    at call (llm.ts:1)\n    OPENAI_API_KEY=${SECRETS.envKey}`,
        route: '#/novel/1',
      },
    ],
    logs: [
      { name: 'the-water.log', text: `2026-09-04 INFO 使用 key ${SECRETS.openai}\n2026-09-04 WARN google=${SECRETS.google} github=${SECRETS.github}\n` },
      { name: '../../逃逸.log', text: '普通日志一行\n' },
    ],
    counts: { 文档: 12, 小说: 3 },
  };
}

describe('脱敏基本规则', () => {
  it('认得出常见密钥形状', () => {
    for (const s of [SECRETS.openai, SECRETS.deepseek, SECRETS.google, SECRETS.github, SECRETS.bearer]) {
      expect(redactText(`前缀 ${s} 后缀`)).not.toContain(s);
    }
  });

  it('key=value 形式整体打码', () => {
    expect(redactText('api_key=abc123 其他')).toBe(`api_key=${REDACTED} 其他`);
    expect(redactText('"token": "whatever"')).toBe(`"token": ${REDACTED}`);
    expect(redactText('password = 123456')).toBe(`password = ${REDACTED}`);
  });

  it('URL 去掉 user:password@ 与 query', () => {
    expect(redactUrl(`http://alice:${SECRETS.proxyPassword}@proxy.local:8080`)).toBe('http://proxy.local:8080/');
    const u = redactUrl(`https://api.x.com/v1?api_key=${SECRETS.queryKey}`);
    expect(u).not.toContain(SECRETS.queryKey);
    expect(u).toContain('https://api.x.com/v1');
  });

  it('长随机串按「同时含大小写和数字」判定，哈希与 UUID 不误伤', () => {
    expect(looksLikeSecretToken(SECRETS.header)).toBe(true);
    expect(looksLikeSecretToken('a'.repeat(64))).toBe(false);
    // sha256 十六进制（纯小写）与 UUID 都该留着，它们是定位问题的线索
    expect(looksLikeSecretToken('9f'.repeat(32))).toBe(false);
    expect(redactText('sha=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'))
      .toContain('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
    expect(redactText('id 550e8400-e29b-41d4-a716-446655440000')).toContain('550e8400-e29b-41d4-a716-446655440000');
  });

  it('请求头只留名字', () => {
    expect(redactHeaders({ Authorization: 'Bearer x', 'X-Trace': 'on' })).toEqual({ Authorization: REDACTED, 'X-Trace': REDACTED });
    expect(redactHeaders(null)).toEqual({});
  });

  it('递归打掉敏感键名的值', () => {
    expect(redactJson({ a: 1, apiKey: 'x', deep: [{ session: 'y' }] })).toEqual({ a: 1, apiKey: REDACTED, deep: [{ session: REDACTED }] });
  });

  it('clientId 只留头尾', () => {
    expect(maskId('cli_0123456789abcdef')).toBe('cli_…cdef');
    expect(maskId('')).toBe('');
  });

  it('日志文件名不会跑出 logs/ 目录', () => {
    expect(safeLogName('../../逃逸.log')).not.toContain('/');
    expect(safeLogName('../../逃逸.log')).not.toContain('..');
    expect(safeLogName('the-water.log')).toBe('the-water.log');
  });
});

describe('诊断包脱敏（硬要求）', () => {
  const files = buildDiagnosticsFiles(input());
  const zip = zipDiagnostics(files);
  const unzipped = unzipSync(zip);
  const texts = Object.fromEntries(Object.entries(unzipped).map(([n, b]) => [n, strFromU8(b)]));
  const everything = Object.values(texts).join('\n');

  it('产出的每个文件里都搜不到任何一个密钥原文', () => {
    for (const [label, secret] of Object.entries(SECRETS)) {
      for (const [name, text] of Object.entries(texts)) {
        expect(text, `${name} 里泄漏了 ${label}`).not.toContain(secret);
      }
    }
  });

  it('zip 字节里也搜不到密钥原文', () => {
    const raw = strFromU8(zip, true);
    for (const [label, secret] of Object.entries(SECRETS)) {
      expect(raw.includes(secret), `zip 字节里泄漏了 ${label}`).toBe(false);
    }
  });

  it('该有的文件都在', () => {
    expect(Object.keys(unzipped).sort()).toEqual([
      'README.txt', 'errors.txt', 'logs/逃逸.log', 'logs/the-water.log', 'providers.json', 'settings.json', 'summary.txt',
    ].sort());
  });

  it('脱敏之后仍然留下了能定位问题的信息', () => {
    expect(texts['summary.txt']).toContain('0.1.0');
    expect(texts['summary.txt']).toContain('aarch64');
    expect(texts['summary.txt']).toContain('文档：12');
    const providers = JSON.parse(texts['providers.json']!) as Array<Record<string, unknown>>;
    expect(providers).toHaveLength(2);
    expect(providers[0]!.model).toBe('deepseek-chat');
    expect(providers[0]!.baseUrl).toContain('https://api.deepseek.com/v1');
    // 请求头的名字要留着：我们得知道用户加了哪些头
    expect(providers[0]!.extraHeaders).toEqual({ Authorization: REDACTED, 'X-Trace': REDACTED });
    // 代理主机留着，口令没了
    expect(providers[0]!.proxyUrl).toContain('proxy.local:8080');
    expect(texts['errors.txt']).toContain('401 Unauthorized');
    expect(texts['errors.txt']).toContain('#/novel/1');
    expect(texts['logs/the-water.log']).toContain('WARN');
    const settings = JSON.parse(texts['settings.json']!) as Record<string, unknown>;
    expect(settings.theme).toBe('dark');
    expect(settings.clientId).toBe('cli_…cdef');
  });

  it('README 说清楚了包里有什么、脱敏了什么', () => {
    expect(texts['README.txt']).toContain('API Key');
    expect(texts['README.txt']).toContain('钥匙串');
    expect(everything.length).toBeGreaterThan(500);
  });

  it('文件名带时间戳', () => {
    expect(diagnosticsFileName(new Date(2026, 8, 4, 15, 30))).toBe('the-water-diagnostics-20260904-1530.zip');
  });

  it('没有日志时也给一个说明文件', () => {
    const files2 = buildDiagnosticsFiles({ ...input(), logs: [], errors: [] });
    expect(files2['logs/README.txt']).toContain('日志目录');
    expect(files2['errors.txt']).toContain('没有记录到错误');
  });

  it('单个供应商的脱敏是可单独验证的纯函数', () => {
    const p = redactProvider(input().providers[1]!);
    expect(JSON.stringify(p)).not.toContain(SECRETS.openai);
    // secretRef 是钥匙串条目名，不是密钥，留着才能对上是哪一条
    expect(p.secretRef).toBe('env:OPENAI_API_KEY');
  });
});

describe('最近错误缓冲', () => {
  it('记录、取出、清空', () => {
    clearRecentErrors();
    recordError({ error: new Error('炸了'), scope: '书架', route: '#/library', at: 1 });
    recordError({ error: '字符串错误', scope: '阅读器', at: 2 });
    const got = recentErrors();
    expect(got.map((e) => e.message)).toEqual(['炸了', '字符串错误']);
    expect(got[0]!.scope).toBe('书架');
    expect(got[0]!.stack).toContain('Error: 炸了');
    clearRecentErrors();
    expect(recentErrors()).toEqual([]);
  });

  it('同一条错误在很短时间内重复上报只记一次', () => {
    clearRecentErrors();
    // main.tsx 的 window.onerror 会再 console.error 一次，两条路径不该记成两条
    recordError({ error: '同一个错', scope: '未捕获异常', at: 1000 });
    recordError({ error: '同一个错', scope: 'console.error', at: 1010 });
    recordError({ error: '同一个错', scope: 'console.error', at: 5000 });
    expect(recentErrors().map((e) => e.at)).toEqual([1000, 5000]);
    clearRecentErrors();
  });

  it('只留最近若干条', () => {
    clearRecentErrors();
    for (let i = 0; i < MAX_RECENT_ERRORS + 20; i += 1) recordError({ error: `第 ${i} 条`, at: i });
    const got = recentErrors();
    expect(got).toHaveLength(MAX_RECENT_ERRORS);
    expect(got[0]!.message).toBe(`第 ${20} 条`);
    clearRecentErrors();
  });
});
