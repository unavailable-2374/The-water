/**
 * 价格表与费用估算（§2.1 第 3 条）。纯函数，不碰数据库。
 *
 * 内置价格是「各供应商公开定价页上的列表价」，按 `asOf` 标注抓取时间；
 * 它们只是**默认值**，用户可以在「用量与费用」面板里逐条改（覆盖值存 model_prices 表，
 * 见 `db/repos/usageRepo.ts`）。国内供应商按元计价，海外供应商按美元计价，
 * 展示时统一折成人民币，汇率同样可改（设置键 usdToCnyRate）。
 *
 * 模型名用「前缀匹配」：写 deepseek-chat 就能同时命中 deepseek-chat-0324 这类带日期后缀的
 * 变体，避免每出一个快照版本就要补一行。
 */
import type { ProviderKind, Usage } from '@/llm/types';
import { DEFAULT_CJK_TOKEN_RATIO } from '@/llm/tokens';
import { ASK_RATIO } from '@/novel/wordBudget';

export type PriceCurrency = 'CNY' | 'USD';

export interface ModelPrice {
  /** `${providerKind}:${model}`，全小写。 */
  id: string;
  /** 空字符串表示「任何协议都可以命中」。 */
  providerKind: ProviderKind | '';
  model: string;
  /** 每百万输入 token 的价格。 */
  inputPerMTok: number;
  /** 每百万输出 token 的价格。 */
  outputPerMTok: number;
  currency: PriceCurrency;
  source: 'builtin' | 'user';
}

/** 内置价格的抓取时间，用来在界面上提醒用户「可能已经变了」。 */
export const BUILTIN_PRICE_AS_OF = '2026-05';

/** 美元折人民币的默认汇率；可用设置键 usdToCnyRate 覆盖。 */
export const DEFAULT_USD_TO_CNY = 7.2;

export function priceId(providerKind: string, model: string): string {
  return `${providerKind.trim().toLowerCase()}:${model.trim().toLowerCase()}`;
}

function builtin(providerKind: ProviderKind | '', model: string, inputPerMTok: number, outputPerMTok: number, currency: PriceCurrency): ModelPrice {
  return { id: priceId(providerKind, model), providerKind, model, inputPerMTok, outputPerMTok, currency, source: 'builtin' };
}

/**
 * 内置默认价格。覆盖 `llm/factory.ts` 的五个预设模型，外加各家常见的便宜档
 * ——「便宜模型跑总结 / 审校」（§2.1 第 2 条）要落地，价格表里就得有便宜档。
 */
export const BUILTIN_PRICES: ModelPrice[] = [
  // DeepSeek（元 / 百万 token）
  builtin('openai_compatible', 'deepseek-chat', 2, 8, 'CNY'),
  builtin('openai_compatible', 'deepseek-reasoner', 4, 16, 'CNY'),
  // 通义千问 DashScope（元 / 百万 token）
  builtin('openai_compatible', 'qwen-turbo', 0.3, 0.6, 'CNY'),
  builtin('openai_compatible', 'qwen-plus', 0.8, 2, 'CNY'),
  builtin('openai_compatible', 'qwen-max', 2.4, 9.6, 'CNY'),
  // Kimi / Moonshot（元 / 百万 token）
  builtin('openai_compatible', 'kimi-k2', 4, 16, 'CNY'),
  builtin('openai_compatible', 'moonshot-v1', 24, 24, 'CNY'),
  // OpenAI（美元 / 百万 token）
  builtin('openai_compatible', 'gpt-4.1-nano', 0.1, 0.4, 'USD'),
  builtin('openai_compatible', 'gpt-4.1-mini', 0.4, 1.6, 'USD'),
  builtin('openai_compatible', 'gpt-4.1', 2, 8, 'USD'),
  builtin('openai_compatible', 'gpt-4o-mini', 0.15, 0.6, 'USD'),
  builtin('openai_compatible', 'gpt-4o', 2.5, 10, 'USD'),
  // Anthropic（美元 / 百万 token）
  builtin('anthropic', 'claude-haiku-4-5', 1, 5, 'USD'),
  builtin('anthropic', 'claude-sonnet-4-5', 3, 15, 'USD'),
  builtin('anthropic', 'claude-opus-4-5', 5, 25, 'USD'),
];

/** 用户覆盖优先，其余用内置；结果按 id 去重。 */
export function mergePrices(user: readonly ModelPrice[], builtinList: readonly ModelPrice[] = BUILTIN_PRICES): ModelPrice[] {
  const byId = new Map<string, ModelPrice>();
  for (const p of builtinList) byId.set(p.id, p);
  for (const p of user) byId.set(p.id, { ...p, source: 'user' });
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 找出模型对应的价格：同协议下最长的模型名前缀优先，其次是不限协议的条目。
 * 找不到返回 null（费用按 0 记，界面上标「未配置价格」）。
 */
export function matchPrice(prices: readonly ModelPrice[], model: string, providerKind?: string): ModelPrice | null {
  const m = model.trim().toLowerCase();
  if (!m) return null;
  const kind = (providerKind ?? '').trim().toLowerCase();
  let best: ModelPrice | null = null;
  let bestScore = -1;
  for (const p of prices) {
    const pm = p.model.trim().toLowerCase();
    if (!pm || !m.startsWith(pm)) continue;
    // 调用方不知道协议（例如聊天记录里只存了模型名）时不按协议筛，只按模型名匹配。
    const kindMatch = p.providerKind === '' || kind === '' ? 0 : p.providerKind.toLowerCase() === kind ? 1 : -1;
    if (kindMatch < 0) continue;
    // 先比模型名长度（越长越具体），再比协议是否对上。
    const score = pm.length * 2 + kindMatch;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

export function toCny(amount: number, currency: PriceCurrency, usdToCny: number = DEFAULT_USD_TO_CNY): number {
  return currency === 'USD' ? amount * usdToCny : amount;
}

/** 一次调用的费用（元）。价格缺失时返回 0。 */
export function costOfUsage(usage: Usage, price: ModelPrice | null, usdToCny: number = DEFAULT_USD_TO_CNY): number {
  if (!price) return 0;
  const raw = (Math.max(0, usage.inputTokens) * price.inputPerMTok + Math.max(0, usage.outputTokens) * price.outputPerMTok) / 1_000_000;
  return toCny(raw, price.currency, usdToCny);
}

/** 人民币金额的展示文本：不足一分钱也不写成「0.00 元」，避免用户以为免费。 */
export function formatCny(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return '¥0.00';
  if (amount < 0.01) return '<¥0.01';
  if (amount < 100) return `¥${amount.toFixed(2)}`;
  return `¥${amount.toFixed(0)}`;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0 });

// ---------------------------------------------------------------------------
// 费用预估
// ---------------------------------------------------------------------------

/** 系统提示 + 文风块 + 题材包的固定开销（token），经验值。 */
export const PROMPT_OVERHEAD_TOKENS = 900;

/** 没有更好的信息时，喂给一章的上下文（章节计划 / 圣经 / 前情摘要 / 上一章结尾）按目标字数的这个倍数估。 */
export const CONTEXT_CHARS_RATIO = 1.2;

export type ChapterWorkMode = 'write' | 'rewrite' | 'revise' | 'name_replace';

export interface ChapterEstimateInput {
  targetChars: number;
  mode: ChapterWorkMode;
  /** 已知的上下文字符数；不传按 targetChars × CONTEXT_CHARS_RATIO 估。 */
  contextChars?: number;
  /** 每个汉字大约多少 token。 */
  ratio?: number;
  /** 该章会不会走 adjust_length 的扩写 / 精简（默认按「有一半概率要调一次」算）。 */
  adjustLength?: boolean;
  /** 该章会不会走 style_check。 */
  styleCheck?: boolean;
  /** 该章会不会走 summarize。 */
  summarize?: boolean;
}

export interface ChapterEstimate {
  /** 走强模型（写作 / 改写 / 扩写 / 定点修订）的部分。 */
  writing: Usage;
  /** 走便宜模型（总结、风格审校、设定校对）的部分。 */
  auxiliary: Usage;
}

const tok = (chars: number, ratio: number) => Math.max(0, Math.round(chars * ratio));

/**
 * 单章 token 估算。比原来的 `targetChars * 2` 靠谱在三点：
 * 分开算输入 / 输出（两者单价差 4 倍）、分开算强模型 / 便宜模型、把流水线里
 * 其余几步（扩写、审校、总结）也算进去。
 */
export function estimateChapter(input: ChapterEstimateInput): ChapterEstimate {
  const ratio = input.ratio ?? DEFAULT_CJK_TOKEN_RATIO;
  const target = Math.max(0, Math.round(input.targetChars));
  if (input.mode === 'name_replace' || target === 0) return { writing: emptyUsage(), auxiliary: emptyUsage() };

  const contextChars = input.contextChars ?? Math.round(target * CONTEXT_CHARS_RATIO);
  const oldTextChars = input.mode === 'write' ? 0 : target;
  const writeIn = tok(contextChars + oldTextChars, ratio) + PROMPT_OVERHEAD_TOKENS;
  const writeOut = tok(target * ASK_RATIO, ratio);
  const writing: Usage = { inputTokens: writeIn, outputTokens: writeOut };

  // adjust_length：整章重发一遍 + 重出一遍，按「一半的章节要调一次」摊。
  if (input.adjustLength !== false) {
    writing.inputTokens += Math.round((tok(target, ratio) + PROMPT_OVERHEAD_TOKENS) * 0.5);
    writing.outputTokens += Math.round(writeOut * 0.5);
  }

  const auxiliary = emptyUsage();
  if (input.summarize !== false) {
    // 总结：正文进、几百字的 JSON 出。
    auxiliary.inputTokens += tok(target, ratio) + PROMPT_OVERHEAD_TOKENS;
    auxiliary.outputTokens += tok(600, ratio);
  }
  if (input.styleCheck) {
    // 风格审校 + 设定校对：正文各进一遍，出评分与问题清单。
    auxiliary.inputTokens += (tok(target, ratio) + PROMPT_OVERHEAD_TOKENS) * 2;
    auxiliary.outputTokens += tok(1200, ratio);
  }
  return { writing, auxiliary };
}

export function sumEstimates(items: readonly ChapterEstimate[]): ChapterEstimate {
  return items.reduce<ChapterEstimate>(
    (acc, e) => ({ writing: addUsage(acc.writing, e.writing), auxiliary: addUsage(acc.auxiliary, e.auxiliary) }),
    { writing: emptyUsage(), auxiliary: emptyUsage() },
  );
}

export interface EstimateCostInput {
  estimate: ChapterEstimate;
  writingPrice: ModelPrice | null;
  auxiliaryPrice: ModelPrice | null;
  usdToCny?: number;
}

export interface CostEstimate { costCny: number; usage: Usage; priced: boolean }

export function estimateCost({ estimate, writingPrice, auxiliaryPrice, usdToCny = DEFAULT_USD_TO_CNY }: EstimateCostInput): CostEstimate {
  const costCny = costOfUsage(estimate.writing, writingPrice, usdToCny) + costOfUsage(estimate.auxiliary, auxiliaryPrice, usdToCny);
  return { costCny, usage: addUsage(estimate.writing, estimate.auxiliary), priced: !!writingPrice || !!auxiliaryPrice };
}

/**
 * 改写计划的 token 估算——用来替换 `RewritePlanDialog.tsx` 里的 `targetChars * 2`。
 * name_replace 是本地字符串替换，不调模型，所以为 0。
 */
export function estimateRewrite(
  items: ReadonlyArray<{ targetChars: number; mode: ChapterWorkMode }>,
  opts: { styleCheck?: boolean; ratio?: number } = {},
): ChapterEstimate {
  return sumEstimates(items.map((it) => estimateChapter({ targetChars: it.targetChars, mode: it.mode, styleCheck: opts.styleCheck, ratio: opts.ratio })));
}

/** 整本书（或一批章节）的写作估算。 */
export function estimateGeneration(
  chapters: ReadonlyArray<{ targetChars: number }>,
  opts: { styleCheck?: boolean; ratio?: number } = {},
): ChapterEstimate {
  return sumEstimates(chapters.map((c) => estimateChapter({ targetChars: c.targetChars, mode: 'write', styleCheck: opts.styleCheck, ratio: opts.ratio })));
}

/** 规划阶段（大纲 + 章节表）的估算：按章数走，输出是结构化 JSON。 */
export function estimatePlanning(chapterCount: number, ratio: number = DEFAULT_CJK_TOKEN_RATIO): Usage {
  const batches = Math.max(1, Math.ceil(chapterCount / 12));
  return {
    // 大纲一轮 + 章节表每批都要把大纲带上。
    inputTokens: PROMPT_OVERHEAD_TOKENS * (1 + batches) + tok(1500, ratio) * batches,
    outputTokens: tok(2500, ratio) + tok(180, ratio) * chapterCount,
  };
}

// ---------------------------------------------------------------------------
// 预算上限
// ---------------------------------------------------------------------------

export interface BudgetSettings {
  /** 每月上限（元），null = 不限。 */
  monthlyCny: number | null;
  /** 单本上限（元），null = 不限。 */
  perNovelCny: number | null;
  /** 到达上限的这个比例时开始提醒，默认 0.8。 */
  warnRatio: number;
}

export const DEFAULT_BUDGET: BudgetSettings = { monthlyCny: null, perNovelCny: null, warnRatio: 0.8 };

export type BudgetLevel = 'off' | 'ok' | 'warn' | 'over';

export interface BudgetStatus { level: BudgetLevel; spent: number; limit: number | null; ratio: number }

export function budgetStatus(spent: number, limit: number | null, warnRatio = DEFAULT_BUDGET.warnRatio): BudgetStatus {
  if (limit == null || limit <= 0) return { level: 'off', spent, limit, ratio: 0 };
  const ratio = spent / limit;
  const level: BudgetLevel = ratio >= 1 ? 'over' : ratio >= warnRatio ? 'warn' : 'ok';
  return { level, spent, limit, ratio };
}
