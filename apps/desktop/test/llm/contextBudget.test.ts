import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { createProvider, getProvider, updateProvider } from '@/db/repos/providersRepo';
import { downgradeScale, withContextDowngrade } from '@/llm/contextBudget';
import { buildContextBudget } from '@/llm/prompts/context';
import { resolveTimeouts } from '@/llm/timeout';
import { CONTEXT_DOWNGRADE_FACTOR, DEFAULT_FIRST_BYTE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS } from '@/llm/config';
import { findPresetForModel, modelParams, PROVIDER_PRESETS } from '@/llm/factory';
import { LLMError, type ProviderCaps } from '@/llm/types';

const caps: ProviderCaps = { contextWindow: 128_000, maxOutputTokens: 8192, jsonMode: 'json_object', cjkTokenRatio: 0.7 };

describe('buildContextBudget', () => {
  it('扣掉输出上限、安全余量与额外预留', () => {
    expect(buildContextBudget({ caps, maxTokens: 5200 })).toBe(128_000 - 5200 - 1500);
    expect(buildContextBudget({ caps, maxTokens: 5200, safety: 0 })).toBe(122_800);
    expect(buildContextBudget({ caps, maxTokens: 5200, reserved: 800 })).toBe(128_000 - 5200 - 1500 - 800);
  });

  it('降档系数按比例缩小预算，且不会为负', () => {
    const full = buildContextBudget({ caps, maxTokens: 5200 });
    expect(buildContextBudget({ caps, maxTokens: 5200, scale: 0.7 })).toBe(Math.floor(full * 0.7));
    expect(buildContextBudget({ caps: { ...caps, contextWindow: 1000 }, maxTokens: 5200, scale: 0.7 })).toBe(0);
  });
});

describe('withContextDowngrade', () => {
  it('第 n 档系数是 factor 的 n 次方', () => {
    expect(downgradeScale(0)).toBe(1);
    expect(downgradeScale(1)).toBeCloseTo(CONTEXT_DOWNGRADE_FACTOR);
    expect(downgradeScale(2, 0.5)).toBe(0.25);
  });

  it('首次成功时不降档', async () => {
    const scales: number[] = [];
    const r = await withContextDowngrade(async (scale) => {
      scales.push(scale);
      return 'ok';
    });
    expect(r).toBe('ok');
    expect(scales).toEqual([1]);
  });

  it('命中 context_length 时缩一档重试一次', async () => {
    const scales: number[] = [];
    const downgrades: number[] = [];
    const r = await withContextDowngrade(
      async (scale, attempt) => {
        scales.push(scale);
        if (attempt === 0) throw new LLMError('context_length', 'HTTP 400: maximum context length');
        return 'ok';
      },
      { onDowngrade: (info) => downgrades.push(info.nextScale) },
    );
    expect(r).toBe('ok');
    expect(scales).toEqual([1, CONTEXT_DOWNGRADE_FACTOR]);
    expect(downgrades).toEqual([CONTEXT_DOWNGRADE_FACTOR]);
  });

  it('两次都失败才上抛', async () => {
    let calls = 0;
    await expect(
      withContextDowngrade(async () => {
        calls++;
        throw new LLMError('context_length', 'too long');
      }),
    ).rejects.toMatchObject({ kind: 'context_length' });
    expect(calls).toBe(2);
  });

  it('其它错误直接上抛，不占用降档次数', async () => {
    let calls = 0;
    await expect(
      withContextDowngrade(async () => {
        calls++;
        throw new LLMError('network', '首字节超时', { raw: 'timeout:first_byte' });
      }),
    ).rejects.toMatchObject({ kind: 'network' });
    expect(calls).toBe(1);
  });

  it('attempts 可配，能连降多档', async () => {
    const scales: number[] = [];
    await expect(
      withContextDowngrade(
        async (scale) => {
          scales.push(scale);
          throw new LLMError('context_length', 'too long');
        },
        { attempts: 3, factor: 0.5 },
      ),
    ).rejects.toMatchObject({ kind: 'context_length' });
    expect(scales).toEqual([1, 0.5, 0.25]);
  });
});

describe('供应商预设', () => {
  it('每个预设都给出模型表并锁定 contextWindow', () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.models.length).toBeGreaterThan(0);
      expect(p.lockContextWindow).toBe(true);
      // 顶层默认值就是 models[0]，UI 选中预设时可以直接用。
      expect(p.model).toBe(p.models[0]!.model);
      expect(p.contextWindow).toBe(p.models[0]!.contextWindow);
      expect(p.maxOutputTokens).toBe(p.models[0]!.maxOutputTokens);
      for (const m of p.models) expect(m.contextWindow).toBeGreaterThan(0);
    }
  });

  it('按模型名可以查回权威上下文参数', () => {
    expect(modelParams('deepseek-chat')).toMatchObject({ contextWindow: 128000, maxOutputTokens: 8192 });
    expect(modelParams('gpt-4o', 'openai')).toMatchObject({ contextWindow: 128000 });
    expect(modelParams('gpt-4o', 'deepseek')).toBeNull();
    expect(modelParams('  claude-sonnet-4-5 ')?.contextWindow).toBe(200000);
    expect(modelParams('不存在的模型')).toBeNull();
    expect(findPresetForModel('qwen-plus')?.id).toBe('qwen');
    expect(findPresetForModel('不存在的模型')).toBeUndefined();
  });
});

describe('供应商运行时列（0004_provider_runtime）', () => {
  beforeEach(() => {
    useTestDb();
  });

  const base = {
    name: 'T',
    kind: 'openai_compatible' as const,
    baseUrl: 'https://x',
    model: 'm',
    contextWindow: 1000,
    maxOutputTokens: 100,
    jsonMode: 'none' as const,
    temperature: 0.5,
    extraHeaders: {},
    secretRef: 'env:X_API_KEY',
  };

  it('不传时落库为默认超时，并能被 resolveTimeouts 读到', async () => {
    const p = await createProvider(base);
    expect(p.firstByteTimeoutMs).toBe(DEFAULT_FIRST_BYTE_TIMEOUT_MS);
    expect(p.idleTimeoutMs).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(p.proxyUrl).toBe('');
    expect(p.concurrency).toBe(1);
    expect(resolveTimeouts(p)).toEqual({ firstByteMs: DEFAULT_FIRST_BYTE_TIMEOUT_MS, idleMs: DEFAULT_IDLE_TIMEOUT_MS });
  });

  it('可写入并更新自定义超时 / 代理 / 并发', async () => {
    const p = await createProvider({ ...base, firstByteTimeoutMs: 15_000, idleTimeoutMs: 30_000, proxyUrl: 'http://127.0.0.1:7890', concurrency: 3 });
    expect(resolveTimeouts(p)).toEqual({ firstByteMs: 15_000, idleMs: 30_000 });
    expect(p.proxyUrl).toBe('http://127.0.0.1:7890');
    expect(p.concurrency).toBe(3);

    await updateProvider(p.id, { idleTimeoutMs: 45_000 });
    const after = await getProvider(p.id);
    expect(after?.idleTimeoutMs).toBe(45_000);
    expect(after?.firstByteTimeoutMs).toBe(15_000); // 未改的列保持不变
  });
});
