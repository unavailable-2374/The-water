/**
 * 用量与费用（§2.1 第 3 条）。
 *
 * 每次 LLM 调用记一行 usage_events，费用按**记账当时**的价格换算后一起存下来；
 * 之后用户改价格表不会改写历史账单。价格表 = 内置默认值（novel/pricing.ts）
 * 与 model_prices 表里的用户覆盖合并，用户条目优先。
 */
import { nanoid } from 'nanoid';
import { getDb, now, selectOne } from '../db';
import { num } from '../mappers';
import { getSetting, setSetting } from './settingsRepo';
import {
  BUILTIN_PRICES, DEFAULT_BUDGET, DEFAULT_USD_TO_CNY, budgetStatus, costOfUsage, matchPrice, mergePrices, priceId,
  type BudgetSettings, type BudgetStatus, type ModelPrice, type PriceCurrency,
} from '@/novel/pricing';
import type { Usage } from '@/llm/types';

export type UsagePurpose = 'writing' | 'planning' | 'summarize' | 'styleReview' | 'consistency' | 'extractStyle' | 'chat';

export const USAGE_PURPOSE_LABELS: Record<UsagePurpose, string> = {
  writing: '写作', planning: '规划', summarize: '总结', styleReview: '风格审校', consistency: '设定校对', extractStyle: '拆书', chat: '对话',
};

export interface UsageEvent {
  id: string; novelId: string | null; jobId: string | null; stepId: string | null; conversationId: string | null;
  purpose: UsagePurpose; providerId: string | null; providerKind: string; model: string;
  inputTokens: number; outputTokens: number; costCny: number; priceId: string | null; createdAt: number;
}
interface RawU {
  id: string; novel_id: string | null; job_id: string | null; step_id: string | null; conversation_id: string | null;
  purpose: string; provider_id: string | null; provider_kind: string; model: string;
  input_tokens: number; output_tokens: number; cost_cny: number; price_id: string | null; created_at: number;
}
const mapU = (r: RawU): UsageEvent => ({
  id: r.id, novelId: r.novel_id, jobId: r.job_id, stepId: r.step_id, conversationId: r.conversation_id,
  purpose: r.purpose as UsagePurpose, providerId: r.provider_id, providerKind: r.provider_kind ?? '', model: r.model ?? '',
  inputTokens: num(r.input_tokens), outputTokens: num(r.output_tokens), costCny: num(r.cost_cny), priceId: r.price_id, createdAt: r.created_at,
});

// ---------------------------------------------------------------------------
// 价格表
// ---------------------------------------------------------------------------

interface RawP { id: string; provider_kind: string; model: string; input_per_mtok: number; output_per_mtok: number; currency: string; updated_at: number }
const mapP = (r: RawP): ModelPrice => ({
  id: r.id, providerKind: (r.provider_kind ?? '') as ModelPrice['providerKind'], model: r.model,
  inputPerMTok: num(r.input_per_mtok), outputPerMTok: num(r.output_per_mtok), currency: (r.currency as PriceCurrency) ?? 'CNY', source: 'user',
});

export async function listUserPrices(): Promise<ModelPrice[]> {
  return (await getDb().select<RawP>('SELECT * FROM model_prices ORDER BY id')).map(mapP);
}

/** 内置价格 + 用户覆盖，界面与记账都用这一份。 */
export async function effectivePrices(): Promise<ModelPrice[]> {
  return mergePrices(await listUserPrices(), BUILTIN_PRICES);
}

export async function upsertPrice(input: { providerKind: string; model: string; inputPerMTok: number; outputPerMTok: number; currency: PriceCurrency }): Promise<void> {
  const id = priceId(input.providerKind, input.model);
  await getDb().execute(
    `INSERT INTO model_prices(id, provider_kind, model, input_per_mtok, output_per_mtok, currency, updated_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET provider_kind = excluded.provider_kind, model = excluded.model,
       input_per_mtok = excluded.input_per_mtok, output_per_mtok = excluded.output_per_mtok, currency = excluded.currency, updated_at = excluded.updated_at`,
    [id, input.providerKind, input.model, Math.max(0, input.inputPerMTok), Math.max(0, input.outputPerMTok), input.currency, now()],
  );
}

/** 删除用户覆盖，该条目回落到内置默认值。 */
export async function resetPrice(id: string): Promise<void> {
  await getDb().execute('DELETE FROM model_prices WHERE id = ?', [id]);
}

export async function getUsdToCnyRate(): Promise<number> {
  const v = await getSetting<number>('usdToCnyRate', DEFAULT_USD_TO_CNY);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_USD_TO_CNY;
}
export async function setUsdToCnyRate(rate: number): Promise<void> {
  await setSetting('usdToCnyRate', Math.max(0.01, rate));
}

// ---------------------------------------------------------------------------
// 记账
// ---------------------------------------------------------------------------

export interface RecordUsageInput {
  usage: Usage;
  purpose: UsagePurpose;
  model: string;
  providerKind?: string;
  providerId?: string | null;
  novelId?: string | null;
  jobId?: string | null;
  stepId?: string | null;
  conversationId?: string | null;
}

/** 记一条用量；token 全为 0 时直接跳过，免得账本里全是空行。 */
export async function recordUsage(input: RecordUsageInput): Promise<UsageEvent | null> {
  const inTok = Math.max(0, Math.round(input.usage.inputTokens || 0));
  const outTok = Math.max(0, Math.round(input.usage.outputTokens || 0));
  if (inTok === 0 && outTok === 0) return null;
  const [prices, rate] = await Promise.all([effectivePrices(), getUsdToCnyRate()]);
  const price = matchPrice(prices, input.model, input.providerKind);
  const cost = costOfUsage({ inputTokens: inTok, outputTokens: outTok }, price, rate);
  const id = nanoid();
  await getDb().execute(
    `INSERT INTO usage_events(id, novel_id, job_id, step_id, conversation_id, purpose, provider_id, provider_kind, model, input_tokens, output_tokens, cost_cny, price_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, input.novelId ?? null, input.jobId ?? null, input.stepId ?? null, input.conversationId ?? null, input.purpose,
      input.providerId ?? null, input.providerKind ?? '', input.model ?? '', inTok, outTok, cost, price?.id ?? null, now()],
  );
  return (await selectOne<RawU>('SELECT * FROM usage_events WHERE id = ?', [id]).then((r) => (r ? mapU(r) : null)));
}

// ---------------------------------------------------------------------------
// 聚合
// ---------------------------------------------------------------------------

export interface UsageFilter { novelId?: string; jobId?: string; stepId?: string; purpose?: UsagePurpose; since?: number; until?: number }
export interface UsageTotals { calls: number; inputTokens: number; outputTokens: number; costCny: number }

const emptyTotals = (): UsageTotals => ({ calls: 0, inputTokens: 0, outputTokens: 0, costCny: 0 });

function whereOf(f: UsageFilter): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.novelId) { where.push('novel_id = ?'); params.push(f.novelId); }
  if (f.jobId) { where.push('job_id = ?'); params.push(f.jobId); }
  if (f.stepId) { where.push('step_id = ?'); params.push(f.stepId); }
  if (f.purpose) { where.push('purpose = ?'); params.push(f.purpose); }
  if (f.since != null) { where.push('created_at >= ?'); params.push(f.since); }
  if (f.until != null) { where.push('created_at < ?'); params.push(f.until); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

export async function usageTotals(filter: UsageFilter = {}): Promise<UsageTotals> {
  const { sql, params } = whereOf(filter);
  const r = await selectOne<{ calls: number; i: number | null; o: number | null; c: number | null }>(
    `SELECT COUNT(*) AS calls, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cost_cny) AS c FROM usage_events ${sql}`, params,
  );
  return { calls: num(r?.calls), inputTokens: num(r?.i), outputTokens: num(r?.o), costCny: num(r?.c) };
}

export interface UsageGroup extends UsageTotals { key: string }

export async function usageByPurpose(filter: UsageFilter = {}): Promise<UsageGroup[]> {
  return groupBy('purpose', filter);
}
export async function usageByModel(filter: UsageFilter = {}): Promise<UsageGroup[]> {
  return groupBy('model', filter);
}

async function groupBy(column: 'purpose' | 'model', filter: UsageFilter): Promise<UsageGroup[]> {
  const { sql, params } = whereOf(filter);
  const rows = await getDb().select<{ k: string; calls: number; i: number | null; o: number | null; c: number | null }>(
    `SELECT ${column} AS k, COUNT(*) AS calls, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cost_cny) AS c
       FROM usage_events ${sql} GROUP BY ${column} ORDER BY c DESC`, params,
  );
  return rows.map((r) => ({ key: r.k ?? '', calls: num(r.calls), inputTokens: num(r.i), outputTokens: num(r.o), costCny: num(r.c) }));
}

/** 最近 `months` 个自然月的用量，新的在前。key 形如 2026-09。 */
export async function usageByMonth(months = 6): Promise<UsageGroup[]> {
  const rows = await getDb().select<{ k: string; calls: number; i: number | null; o: number | null; c: number | null }>(
    `SELECT strftime('%Y-%m', created_at / 1000, 'unixepoch', 'localtime') AS k, COUNT(*) AS calls,
            SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cost_cny) AS c
       FROM usage_events GROUP BY k ORDER BY k DESC LIMIT ?`, [Math.max(1, months)],
  );
  return rows.map((r) => ({ key: r.k ?? '', calls: num(r.calls), inputTokens: num(r.i), outputTokens: num(r.o), costCny: num(r.c) }));
}

/** 本月起点（本地时区）的时间戳。 */
export function monthStart(at: number = Date.now()): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

export async function monthlySpend(at: number = Date.now()): Promise<number> {
  return (await usageTotals({ since: monthStart(at) })).costCny;
}

export async function listUsageEvents(filter: UsageFilter = {}, limit = 100): Promise<UsageEvent[]> {
  const { sql, params } = whereOf(filter);
  return (await getDb().select<RawU>(`SELECT * FROM usage_events ${sql} ORDER BY created_at DESC LIMIT ?`, [...params, limit])).map(mapU);
}

export { emptyTotals };

// ---------------------------------------------------------------------------
// 预算
// ---------------------------------------------------------------------------

export async function getBudget(): Promise<BudgetSettings> {
  const raw = await getSetting<Partial<BudgetSettings>>('usageBudget', {});
  return { ...DEFAULT_BUDGET, ...raw };
}
export async function setBudget(patch: Partial<BudgetSettings>): Promise<void> {
  await setSetting('usageBudget', { ...(await getBudget()), ...patch });
}

export interface BudgetReport { monthly: BudgetStatus; perNovel: BudgetStatus | null }

/** 当前的预算状态：本月总花费 + （给定小说时）这本书的累计花费。 */
export async function budgetReport(novelId?: string): Promise<BudgetReport> {
  const budget = await getBudget();
  const spentMonth = await monthlySpend();
  const monthly = budgetStatus(spentMonth, budget.monthlyCny, budget.warnRatio);
  if (!novelId) return { monthly, perNovel: null };
  const spentNovel = (await usageTotals({ novelId })).costCny;
  return { monthly, perNovel: budgetStatus(spentNovel, budget.perNovelCny, budget.warnRatio) };
}

/** 预算超限时抛出，调用方可以让用户确认后带 ignoreBudget 再来一次。 */
export class BudgetExceededError extends Error {
  readonly report: BudgetReport;
  constructor(message: string, report: BudgetReport) {
    super(message);
    this.name = 'BudgetExceededError';
    this.report = report;
  }
}

export async function assertBudget(novelId?: string): Promise<void> {
  const report = await budgetReport(novelId);
  if (report.monthly.level === 'over') {
    throw new BudgetExceededError(`本月 AI 花费已达上限（${report.monthly.spent.toFixed(2)} / ${report.monthly.limit} 元）`, report);
  }
  if (report.perNovel?.level === 'over') {
    throw new BudgetExceededError(`这本书的 AI 花费已达上限（${report.perNovel.spent.toFixed(2)} / ${report.perNovel.limit} 元）`, report);
  }
}
