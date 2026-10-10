import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { createNovel } from '@/db/repos/novelsRepo';
import { appendMessage, createConversation } from '@/db/repos/conversationsRepo';
import {
  BudgetExceededError, assertBudget, budgetReport, effectivePrices, listUsageEvents, monthStart, recordUsage,
  resetPrice, setBudget, setUsdToCnyRate, upsertPrice, usageByMonth, usageByPurpose, usageTotals,
} from '@/db/repos/usageRepo';
import { defaultRequirements } from '@/novel/types';
import { matchPrice } from '@/novel/pricing';

const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o });

beforeEach(() => { useTestDb(); });

describe('用量记账', () => {
  it('按内置价格算钱并落库（DeepSeek：2 元进 / 8 元出，每百万）', async () => {
    const e = await recordUsage({ usage: usage(1_000_000, 1_000_000), purpose: 'writing', model: 'deepseek-chat', providerKind: 'openai_compatible' });
    expect(e).not.toBeNull();
    expect(e!.costCny).toBeCloseTo(10);
    expect(e!.priceId).toBe('openai_compatible:deepseek-chat');
  });

  it('美元定价的模型按汇率折算，汇率可改', async () => {
    await setUsdToCnyRate(7);
    const e = await recordUsage({ usage: usage(1_000_000, 0), purpose: 'writing', model: 'claude-sonnet-4-5', providerKind: 'anthropic' });
    expect(e!.costCny).toBeCloseTo(21); // $3 × 7
  });

  it('token 全为 0 时不记账，账本里不留空行', async () => {
    expect(await recordUsage({ usage: usage(0, 0), purpose: 'chat', model: 'x' })).toBeNull();
    expect(await listUsageEvents()).toHaveLength(0);
  });

  it('没有价格的模型仍然记 token，只是金额为 0', async () => {
    const e = await recordUsage({ usage: usage(1000, 1000), purpose: 'writing', model: '自建模型-v9' });
    expect(e!.costCny).toBe(0);
    expect(e!.priceId).toBeNull();
    expect((await usageTotals()).inputTokens).toBe(1000);
    expect((await usageTotals()).unpricedCalls).toBe(1);
    expect((await usageByPurpose())[0]?.unpricedCalls).toBe(1);
    expect((await usageByMonth())[0]?.unpricedCalls).toBe(1);
  });

  it('改价格只影响之后的账，历史账单不被改写', async () => {
    const before = await recordUsage({ usage: usage(1_000_000, 0), purpose: 'writing', model: 'deepseek-chat', providerKind: 'openai_compatible' });
    await upsertPrice({ providerKind: 'openai_compatible', model: 'deepseek-chat', inputPerMTok: 20, outputPerMTok: 80, currency: 'CNY' });
    const after = await recordUsage({ usage: usage(1_000_000, 0), purpose: 'writing', model: 'deepseek-chat', providerKind: 'openai_compatible' });
    expect(before!.costCny).toBeCloseTo(2);
    expect(after!.costCny).toBeCloseTo(20);
    // 恢复内置价
    await resetPrice('openai_compatible:deepseek-chat');
    expect(matchPrice(await effectivePrices(), 'deepseek-chat', 'openai_compatible')!.inputPerMTok).toBe(2);
  });
});

describe('用量聚合', () => {
  it('按任务 / 按小说 / 按本月分别算得出来', async () => {
    const novel = await createNovel({ title: 'a', premise: '', requirements: defaultRequirements(), targetChars: 1000 });
    const other = await createNovel({ title: 'b', premise: '', requirements: defaultRequirements(), targetChars: 1000 });
    await recordUsage({ usage: usage(1_000_000, 0), purpose: 'writing', model: 'deepseek-chat', providerKind: 'openai_compatible', novelId: novel.id, jobId: 'j1' });
    await recordUsage({ usage: usage(1_000_000, 0), purpose: 'summarize', model: 'deepseek-chat', providerKind: 'openai_compatible', novelId: novel.id, jobId: 'j2' });
    await recordUsage({ usage: usage(1_000_000, 0), purpose: 'writing', model: 'deepseek-chat', providerKind: 'openai_compatible', novelId: other.id, jobId: 'j3' });

    expect((await usageTotals({ jobId: 'j1' })).costCny).toBeCloseTo(2);
    expect((await usageTotals({ novelId: novel.id })).costCny).toBeCloseTo(4);
    expect((await usageTotals({ novelId: novel.id })).calls).toBe(2);
    expect((await usageTotals({ since: monthStart() })).costCny).toBeCloseTo(6);
  });

  it('按用途拆分，看得出钱花在写作还是校读上', async () => {
    await recordUsage({ usage: usage(1_000_000, 0), purpose: 'writing', model: 'deepseek-chat', providerKind: 'openai_compatible', novelId: 'n1' });
    await recordUsage({ usage: usage(100_000, 0), purpose: 'summarize', model: 'deepseek-chat', providerKind: 'openai_compatible', novelId: 'n1' });
    const rows = await usageByPurpose({ novelId: 'n1' });
    expect(rows.map((r) => r.key)).toEqual(['writing', 'summarize']);
    expect(rows[0]!.costCny).toBeGreaterThan(rows[1]!.costCny);
  });

  it('按月分组', async () => {
    await recordUsage({ usage: usage(1000, 0), purpose: 'chat', model: 'deepseek-chat', providerKind: 'openai_compatible' });
    const months = await usageByMonth(6);
    expect(months).toHaveLength(1);
    expect(months[0]!.key).toMatch(/^\d{4}-\d{2}$/);
  });

  it('聊天的用量也进账本（以前只躺在 ai_messages.usage 里）', async () => {
    const conv = await createConversation({ kind: 'scratch' });
    await appendMessage({ conversationId: conv.id, role: 'user', content: '问题' });
    await appendMessage({ conversationId: conv.id, role: 'assistant', content: '回答', usage: usage(1_000_000, 0), model: 'deepseek-chat' });
    const rows = await usageByPurpose({});
    expect(rows.map((r) => r.key)).toEqual(['chat']);
    expect(rows[0]!.costCny).toBeCloseTo(2);
  });
});

describe('预算上限', () => {
  it('没设上限时永远放行', async () => {
    await recordUsage({ usage: usage(100_000_000, 0), purpose: 'writing', model: 'deepseek-chat', providerKind: 'openai_compatible', novelId: 'n1' });
    await expect(assertBudget('n1')).resolves.toBeUndefined();
  });

  it('超过月上限时抛 BudgetExceededError，报告里带着已花与上限', async () => {
    await setBudget({ monthlyCny: 1 });
    await recordUsage({ usage: usage(1_000_000, 0), purpose: 'writing', model: 'deepseek-chat', providerKind: 'openai_compatible', novelId: 'n1' });
    await expect(assertBudget('n1')).rejects.toBeInstanceOf(BudgetExceededError);
    const r = await budgetReport('n1');
    expect(r.monthly.level).toBe('over');
    expect(r.monthly.spent).toBeCloseTo(2);
  });

  it('单本上限独立生效', async () => {
    await setBudget({ monthlyCny: null, perNovelCny: 1 });
    await recordUsage({ usage: usage(1_000_000, 0), purpose: 'writing', model: 'deepseek-chat', providerKind: 'openai_compatible', novelId: 'n1' });
    await expect(assertBudget('n1')).rejects.toBeInstanceOf(BudgetExceededError);
    // 另一本书没花钱，不受影响
    await expect(assertBudget('n2')).resolves.toBeUndefined();
  });

  it('到 80% 只是提醒，不拦', async () => {
    await setBudget({ monthlyCny: 2.5 });
    await recordUsage({ usage: usage(1_000_000, 0), purpose: 'writing', model: 'deepseek-chat', providerKind: 'openai_compatible' });
    expect((await budgetReport()).monthly.level).toBe('warn');
    await expect(assertBudget()).resolves.toBeUndefined();
  });
});
