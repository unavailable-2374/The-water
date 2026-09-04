/**
 * 诊断包的内容组装：把收集到的信息拼成一组纯文本文件。
 *
 * 这一层是纯函数（不碰 Tauri、不碰数据库），方便测试逐个文件核对脱敏效果。
 * 真正的取数与打包在 `bundle.ts`。
 */
import { REDACTED, maskId, redactHeaders, redactJson, redactText, redactUrl } from './redact';
import type { RecordedError } from './recentErrors';

/** 只取诊断需要的字段，避免 diagnostics 反向依赖 llm 的类型。 */
export interface ProviderLike {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  model: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  jsonMode?: string;
  temperature?: number;
  extraHeaders?: Record<string, string> | null;
  secretRef?: string;
  proxyUrl?: string;
  concurrency?: number;
  firstByteTimeoutMs?: number;
  idleTimeoutMs?: number;
  isDefault?: boolean;
}

export interface DiagnosticsInput {
  at: Date;
  app: { version: string; tauriVersion: string; platform: string; arch: string; osVersion: string };
  dirs: { data: string; log: string };
  runtime: { userAgent: string; language: string; screen: string; online: boolean };
  /** 应用设置（AppSettings 原样传进来即可，这里会脱敏）。 */
  settings: Record<string, unknown>;
  providers: ProviderLike[];
  errors: RecordedError[];
  /** 日志文件：name 是文件名，text 是内容（调用方已按大小截过尾）。 */
  logs: Array<{ name: string; text: string }>;
  /** 库里的规模统计，比如 { 文档: 12, 小说: 3 }。取不到就传空。 */
  counts: Record<string, number>;
}

/** 诊断包文件名：the-water-diagnostics-20260904-1530.zip */
export function diagnosticsFileName(at: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `the-water-diagnostics-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}.zip`;
}

const README = `The Water 诊断包
================

这个压缩包是你在「设置 → 通用 → 关于」里点「导出诊断包」生成的，
用来附在反馈里，帮我们复现问题。

里面有什么
----------
  summary.txt    版本号、系统信息、目录位置
  settings.json  应用设置（已脱敏）
  providers.json 模型供应商的配置（已脱敏）
  errors.txt     这次运行期间记录到的错误（已脱敏）
  logs/          应用日志文件（已脱敏）

我们做了哪些脱敏
----------------
  · API Key、密码、会话 token 一律不写入，连打码后的长度都不保留
  · 请求头只保留名字，值全部替换成 ${REDACTED}
  · Base URL / 代理地址去掉 user:password@ 与 query 串
  · 日志与错误堆栈里凡是像密钥的长串一律替换
  · 系统钥匙串从头到尾没有被读取过

它仍然可能包含
--------------
  · 你的文件路径与用户名（出现在目录与日志里）
  · 书名、小说标题这类你自己创建的内容
发出去之前可以先自己翻一遍，删掉不想给的部分再压回去。
`;

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function summaryText(input: DiagnosticsInput): string {
  const lines = [
    'The Water 诊断摘要',
    `生成时间：${fmtTime(input.at.getTime())}`,
    '',
    '[应用]',
    `版本：${input.app.version}`,
    `运行时 Tauri：${input.app.tauriVersion}`,
    '',
    '[系统]',
    `平台：${input.app.platform}`,
    `架构：${input.app.arch}`,
    `系统版本：${input.app.osVersion}`,
    `界面语言：${input.runtime.language}`,
    `屏幕：${input.runtime.screen}`,
    `网络：${input.runtime.online ? '在线' : '离线'}`,
    `UA：${input.runtime.userAgent}`,
    '',
    '[目录]',
    `数据目录：${input.dirs.data}`,
    `日志目录：${input.dirs.log}`,
    '',
    '[规模]',
  ];
  const entries = Object.entries(input.counts);
  if (entries.length === 0) lines.push('（未采集）');
  else for (const [k, v] of entries) lines.push(`${k}：${v}`);
  lines.push('', '[供应商]', `共 ${input.providers.length} 个，详见 providers.json`);
  lines.push('', '[错误]', `共 ${input.errors.length} 条，详见 errors.txt`);
  return redactText(lines.join('\n')) + '\n';
}

/** 供应商配置脱敏：密钥从来不在配置里（它在系统钥匙串），但 header / URL 里可能夹带。 */
export function redactProvider(p: ProviderLike): Record<string, unknown> {
  return {
    id: p.id,
    name: redactText(p.name),
    kind: p.kind,
    model: p.model,
    baseUrl: redactUrl(p.baseUrl),
    contextWindow: p.contextWindow,
    maxOutputTokens: p.maxOutputTokens,
    jsonMode: p.jsonMode,
    temperature: p.temperature,
    // 只留头名，值全打码
    extraHeaders: redactHeaders(p.extraHeaders),
    // secretRef 是钥匙串的条目名（provider:xxx / env:XXX_API_KEY），不是密钥本身
    secretRef: p.secretRef ? redactText(p.secretRef) : '',
    proxyUrl: p.proxyUrl ? redactUrl(p.proxyUrl) : '',
    concurrency: p.concurrency,
    firstByteTimeoutMs: p.firstByteTimeoutMs,
    idleTimeoutMs: p.idleTimeoutMs,
    isDefault: p.isDefault,
  };
}

function settingsJson(settings: Record<string, unknown>): string {
  const copy = redactJson(settings) as Record<string, unknown>;
  // clientId 用来在服务端对上同一台机器，只留头尾就够定位
  if (typeof settings.clientId === 'string') copy.clientId = maskId(settings.clientId);
  return JSON.stringify(copy, null, 2) + '\n';
}

function errorsText(errors: RecordedError[]): string {
  if (errors.length === 0) return '这次运行期间没有记录到错误。\n';
  const out: string[] = [];
  for (const e of errors) {
    out.push(`── ${fmtTime(e.at)} · ${e.scope}${e.route ? ` · ${e.route}` : ''}`);
    out.push(redactText(e.message));
    out.push(redactText(e.stack));
    out.push('');
  }
  return out.join('\n');
}

/** 日志文件名可能来自磁盘，别让它跑出 logs/ 目录。 */
export function safeLogName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '')
    // 控制字符与 Windows 不允许的文件名字符换掉；中文文件名留着
    .replace(/[\u0000-\u001f<>:"|?*\\]/g, '_')
    .replace(/^\.+/, '_');
  return base || 'log.txt';
}

/**
 * 组装诊断包里的所有文件：路径 → 文本内容。
 * 每一份内容都过了脱敏，调用方直接压成 zip 即可。
 */
export function buildDiagnosticsFiles(input: DiagnosticsInput): Record<string, string> {
  const files: Record<string, string> = {
    'README.txt': README,
    'summary.txt': summaryText(input),
    'settings.json': settingsJson(input.settings),
    'providers.json': JSON.stringify(input.providers.map(redactProvider), null, 2) + '\n',
    'errors.txt': errorsText(input.errors),
  };
  if (input.logs.length === 0) {
    files['logs/README.txt'] = '日志目录是空的，或者这次没读到日志文件。\n';
  } else {
    for (const log of input.logs) files[`logs/${safeLogName(log.name)}`] = redactText(log.text);
  }
  return files;
}
