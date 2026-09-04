import { describe, expect, it } from 'vitest';
import { PROVIDER_PRESETS } from '@/llm/factory';
import {
  BUILTIN_PRICES, budgetStatus, costOfUsage, estimateChapter, estimateGeneration, estimatePlanning,
  estimateRewrite, estimateCost, formatCny, matchPrice, mergePrices, priceId, sumEstimates, toCny,
  type ModelPrice,
} from '@/novel/pricing';

const price = (over: Partial<ModelPrice> & Pick<ModelPrice, 'model'>): ModelPrice => ({
  id: priceId(over.providerKind ?? '', over.model), providerKind: '', inputPerMTok: 1, outputPerMTok: 2, currency: 'CNY', source: 'user', ...over,
});

describe('价格匹配', () => {
  it('按最长模型名前缀命中，带日期后缀的变体也认得', () => {
    const list = [price({ model: 'deepseek' }), price({ model: 'deepseek-chat' })];
    expect(matchPrice(list, 'deepseek-chat-0324')!.model).toBe('deepseek-chat');
    expect(matchPrice(list, 'deepseek-reasoner')!.model).toBe('deepseek');
  });

  it('协议对不上就不命中，不限协议的条目仍可兜底', () => {
    const list = [
      price({ model: 'x-1', providerKind: 'anthropic', id: 'anthropic:x-1' }),
      price({ model: 'x-1', providerKind: '', id: ':x-1', outputPerMTok: 9 }),
    ];
    expect(matchPrice(list, 'x-1', 'openai_compatible')!.outputPerMTok).toBe(9);
    expect(matchPrice(list, 'x-1', 'anthropic')!.providerKind).toBe('anthropic');
  });

  it('调用方不知道协议时（聊天记录只存了模型名）按模型名匹配', () => {
    const list = [price({ model: 'claude-sonnet-4-5', providerKind: 'anthropic', id: 'anthropic:claude-sonnet-4-5' })];
    expect(matchPrice(list, 'claude-sonnet-4-5')).not.toBeNull();
  });

  it('找不到返回 null，空模型名也返回 null', () => {
    expect(matchPrice([price({ model: 'a' })], 'b')).toBeNull();
    expect(matchPrice([price({ model: 'a' })], '')).toBeNull();
  });

  it('llm/factory 预设里的每个模型都有内置价格（价格表与预设对齐）', () => {
    for (const preset of PROVIDER_PRESETS) {
      for (const m of preset.models) {
        expect(matchPrice(BUILTIN_PRICES, m.model, preset.kind), `${preset.id}/${m.model}`).not.toBeNull();
      }
    }
  });

  it('用户覆盖优先于内置', () => {
    const merged = mergePrices([price({ model: 'deepseek-chat', providerKind: 'openai_compatible', id: 'openai_compatible:deepseek-chat', inputPerMTok: 999 })]);
    const hit = matchPrice(merged, 'deepseek-chat', 'openai_compatible')!;
    expect(hit.inputPerMTok).toBe(999);
    expect(hit.source).toBe('user');
  });
});

describe('费用换算', () => {
  it('按百万 token 计价，美元按汇率折成人民币', () => {
    const usd = price({ model: 'm', currency: 'USD', inputPerMTok: 3, outputPerMTok: 15 });
    // 1M 输入 + 1M 输出 = 18 美元 = 126 元 @7
    expect(costOfUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, usd, 7)).toBeCloseTo(126);
    expect(toCny(2, 'CNY', 7)).toBe(2);
  });

  it('没有价格时算 0，负数 token 按 0 处理', () => {
    expect(costOfUsage({ inputTokens: 100, outputTokens: 100 }, null)).toBe(0);
    expect(costOfUsage({ inputTokens: -5, outputTokens: 0 }, price({ model: 'm' }))).toBe(0);
  });

  it('金额展示不把「几厘钱」写成 0.00', () => {
    expect(formatCny(0)).toBe('¥0.00');
    expect(formatCny(0.004)).toBe('<¥0.01');
    expect(formatCny(1.239)).toBe('¥1.24');
    expect(formatCny(1234.5)).toBe('¥1235');
  });
});

describe('用量估算', () => {
  it('写一章：输出随目标字数走，输入含上下文与固定开销', () => {
    const e = estimateChapter({ targetChars: 3000, mode: 'write', ratio: 1 });
    expect(e.writing.outputTokens).toBeGreaterThan(3000);
    expect(e.writing.inputTokens).toBeGreaterThan(3000);
    expect(e.auxiliary.outputTokens).toBeGreaterThan(0); // summarize 默认算上
  });

  it('改写比新写多出「原文再进一遍」的输入', () => {
    const w = estimateChapter({ targetChars: 3000, mode: 'write', ratio: 1 });
    const r = estimateChapter({ targetChars: 3000, mode: 'rewrite', ratio: 1 });
    expect(r.writing.inputTokens - w.writing.inputTokens).toBe(3000);
  });

  it('name_replace 不调模型，估算为 0', () => {
    const e = estimateChapter({ targetChars: 3000, mode: 'name_replace' });
    expect(e.writing).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(e.auxiliary).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('开了 style_check 之后便宜模型那一档明显变大', () => {
    const off = estimateChapter({ targetChars: 3000, mode: 'write', ratio: 1 });
    const on = estimateChapter({ targetChars: 3000, mode: 'write', ratio: 1, styleCheck: true });
    expect(on.auxiliary.inputTokens).toBeGreaterThan(off.auxiliary.inputTokens);
    expect(on.writing).toEqual(off.writing);
  });

  it('改写计划的估算跳过改名章节（替换 targetChars*2 粗估）', () => {
    const e = estimateRewrite([
      { targetChars: 3000, mode: 'rewrite' },
      { targetChars: 3000, mode: 'name_replace' },
    ], { ratio: 1 });
    const one = estimateChapter({ targetChars: 3000, mode: 'rewrite', ratio: 1 });
    expect(e).toEqual(sumEstimates([one]));
  });

  it('整本估算随章数线性增长', () => {
    const five = estimateGeneration(Array.from({ length: 5 }, () => ({ targetChars: 2000 })), { ratio: 1 });
    const one = estimateGeneration([{ targetChars: 2000 }], { ratio: 1 });
    expect(five.writing.outputTokens).toBe(one.writing.outputTokens * 5);
  });

  it('规划阶段的估算随章数增长', () => {
    expect(estimatePlanning(60).outputTokens).toBeGreaterThan(estimatePlanning(10).outputTokens);
  });

  it('强模型与便宜模型分别计价', () => {
    const estimate = { writing: { inputTokens: 1_000_000, outputTokens: 0 }, auxiliary: { inputTokens: 1_000_000, outputTokens: 0 } };
    const r = estimateCost({
      estimate,
      writingPrice: price({ model: 'w', inputPerMTok: 10 }),
      auxiliaryPrice: price({ model: 'a', inputPerMTok: 1 }),
    });
    expect(r.costCny).toBeCloseTo(11);
    expect(r.usage.inputTokens).toBe(2_000_000);
    expect(r.priced).toBe(true);
  });
});

describe('预算上限', () => {
  it('没设上限时不参与判断', () => {
    expect(budgetStatus(500, null).level).toBe('off');
    expect(budgetStatus(500, 0).level).toBe('off');
  });
  it('到 80% 提醒，满额告警', () => {
    expect(budgetStatus(50, 100).level).toBe('ok');
    expect(budgetStatus(80, 100).level).toBe('warn');
    expect(budgetStatus(100, 100).level).toBe('over');
    expect(budgetStatus(120, 100).level).toBe('over');
  });
});
