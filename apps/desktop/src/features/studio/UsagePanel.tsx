/**
 * 用量与费用面板（§2.1 第 3 条）。
 *
 * token 用量本来就逐条落库了，只是从没聚合展示过。这里给出三层视图：
 * 每个任务 / 每本书 / 每月，外加一份可编辑的单位价格表和预算上限。
 * 开工前的费用预估也在这里（`previewCost`），供规划页与创建向导复用。
 */
import { useEffect, useState } from 'react';
import { Coins, Pencil, RotateCcw } from 'lucide-react';
import { Button, Card, Dialog, Field, Input, Select, cn } from '@/components/ui';
import { toast } from '@/components/Toast';
import {
  budgetReport, effectivePrices, getBudget, getUsdToCnyRate, resetPrice, setBudget, setUsdToCnyRate,
  upsertPrice, usageByMonth, usageByPurpose, usageTotals, monthStart, USAGE_PURPOSE_LABELS,
  type UsageGroup, type UsagePurpose, type UsageTotals,
} from '@/db/repos/usageRepo';
import {
  BUILTIN_PRICE_AS_OF, estimateCost, formatCny, matchPrice,
  type ChapterEstimate, type ModelPrice, type PriceCurrency,
} from '@/novel/pricing';
import { getNovelProviders } from '@/novel/service';
import { providersForPurposes } from '@/jobs/runner';
import type { StepProviderMap } from '@/jobs/purposes';
import type { Usage } from '@/llm/types';

// ---------------------------------------------------------------------------
// 费用预估
// ---------------------------------------------------------------------------

export interface CostPreview {
  usage: Usage;
  costCny: number;
  /** 至少命中了一条价格；否则界面上要说明「未配置价格」。 */
  priced: boolean;
  writingModel: string;
  auxiliaryModel: string;
}

/** 按将要使用的模型 + 当前价格表，把 token 估算折成钱。 */
export async function previewCost(estimate: ChapterEstimate, providerIds: StepProviderMap): Promise<CostPreview> {
  const [prices, rate] = await Promise.all([effectivePrices(), getUsdToCnyRate()]);
  let writingModel = '';
  let auxiliaryModel = '';
  let writingPrice: ModelPrice | null = null;
  let auxiliaryPrice: ModelPrice | null = null;
  try {
    const map = await providersForPurposes({ params: { providerIds }, providerId: providerIds.writing ?? null }, ['writing', 'summarize']);
    const w = map.writing;
    const a = map.summarize;
    if (w) { writingModel = w.model; writingPrice = matchPrice(prices, w.model, w.kind); }
    if (a) { auxiliaryModel = a.model; auxiliaryPrice = matchPrice(prices, a.model, a.kind); }
  } catch {
    /* 还没配供应商：只给 token 估算，不给金额 */
  }
  const r = estimateCost({ estimate, writingPrice, auxiliaryPrice, usdToCny: rate });
  return { usage: r.usage, costCny: r.costCny, priced: r.priced, writingModel, auxiliaryModel };
}

/** 用这本书已保存的模型选择做预估。 */
export async function previewCostForNovel(novelId: string, estimate: ChapterEstimate): Promise<CostPreview> {
  return previewCost(estimate, await getNovelProviders(novelId));
}

const kilo = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n.toLocaleString());

/** 开工前的一行费用预估。 */
export function CostEstimateLine({ preview, prefix = '预计消耗' }: { preview: CostPreview | null; prefix?: string }) {
  if (!preview) return null;
  const { usage, costCny, priced } = preview;
  return (
    <p className="text-xs leading-relaxed text-ink-500">
      {prefix} <span className="font-serif text-ink-700 dark:text-ink-200">{kilo(usage.inputTokens)}</span> 输入 +{' '}
      <span className="font-serif text-ink-700 dark:text-ink-200">{kilo(usage.outputTokens)}</span> 输出 token
      {priced
        ? <> · 约 <span className="font-serif text-cinnabar-700 dark:text-cinnabar-100">{formatCny(costCny)}</span></>
        : <> · <span className="text-amber-700 dark:text-amber-300">未配置该模型的价格，算不出金额</span></>}
      <span className="text-ink-400">（估算值，实际以账单为准）</span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// 用量卡片
// ---------------------------------------------------------------------------

function StatCard({ label, totals, hint }: { label: string; totals: UsageTotals; hint?: string }) {
  return (
    <div className="rounded-2xl bg-paper-100/70 px-4 py-3 dark:bg-paper-900/70">
      <div className="text-[11px] tracking-wide text-ink-500">{label}</div>
      <div className="mt-1 font-serif text-xl tracking-wide text-ink-900 dark:text-paper-100">{formatCny(totals.costCny)}</div>
      <div className="mt-0.5 text-[11px] text-ink-400">
        {totals.calls} 次调用 · {kilo(totals.inputTokens)} 进 / {kilo(totals.outputTokens)} 出
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-400">{hint}</div>}
    </div>
  );
}

export function UsageCards({ novelId, jobId, tick }: { novelId: string; jobId?: string | null; tick?: number }) {
  const [job, setJob] = useState<UsageTotals | null>(null);
  const [novel, setNovel] = useState<UsageTotals | null>(null);
  const [month, setMonth] = useState<UsageTotals | null>(null);
  const [byPurpose, setByPurpose] = useState<UsageGroup[]>([]);
  const [months, setMonths] = useState<UsageGroup[]>([]);
  const [budget, setBudgetState] = useState<Awaited<ReturnType<typeof budgetReport>> | null>(null);
  const [pricesOpen, setPricesOpen] = useState(false);

  const load = async () => {
    const [j, n, m, p, hist, b] = await Promise.all([
      jobId ? usageTotals({ jobId }) : Promise.resolve(null),
      usageTotals({ novelId }),
      usageTotals({ since: monthStart() }),
      usageByPurpose({ novelId }),
      usageByMonth(6),
      budgetReport(novelId),
    ]);
    setJob(j); setNovel(n); setMonth(m); setByPurpose(p); setMonths(hist); setBudgetState(b);
  };
  useEffect(() => { void load(); }, [novelId, jobId, tick, pricesOpen]);

  const over = budget && (budget.monthly.level === 'over' || budget.perNovel?.level === 'over');
  const warn = budget && !over && (budget.monthly.level === 'warn' || budget.perNovel?.level === 'warn');

  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-2">
        <Coins size={15} strokeWidth={1.75} className="text-ink-400" />
        <h3 className="font-serif text-sm tracking-wide text-ink-800 dark:text-paper-100">用量与费用</h3>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setPricesOpen(true)}><Pencil size={13} strokeWidth={1.75} />价格与预算</Button>
      </div>
      {(over || warn) && (
        <div className={cn('rounded-xl px-3 py-2 text-xs leading-relaxed', over ? 'bg-cinnabar-50 text-cinnabar-700 dark:bg-cinnabar-900/30 dark:text-cinnabar-100' : 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-200')}>
          {budget!.monthly.level !== 'off' && `本月已花 ${formatCny(budget!.monthly.spent)} / 上限 ${formatCny(budget!.monthly.limit!)}。`}
          {budget!.perNovel && budget!.perNovel.level !== 'off' && ` 这本书已花 ${formatCny(budget!.perNovel.spent)} / 上限 ${formatCny(budget!.perNovel.limit!)}。`}
          {over ? ' 已达上限，开始新任务时会先要求你确认。' : ' 快到上限了。'}
        </div>
      )}
      <div className="grid grid-cols-3 gap-2">
        {job && <StatCard label="这个任务" totals={job} />}
        {novel && <StatCard label="这本书" totals={novel} />}
        {month && <StatCard label="本月" totals={month} />}
      </div>
      {byPurpose.length > 0 && (
        <ul className="space-y-1 text-[11px] text-ink-500">
          {byPurpose.map((g) => (
            <li key={g.key} className="flex items-baseline gap-2">
              <span className="w-16 shrink-0">{USAGE_PURPOSE_LABELS[g.key as UsagePurpose] ?? g.key}</span>
              <span className="font-serif text-ink-700 dark:text-ink-200">{formatCny(g.costCny)}</span>
              <span className="text-ink-400">{g.calls} 次 · {kilo(g.inputTokens + g.outputTokens)} token</span>
            </li>
          ))}
        </ul>
      )}
      {months.length > 1 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-400">
          {months.map((m) => <span key={m.key}>{m.key} <span className="font-serif text-ink-600 dark:text-ink-300">{formatCny(m.costCny)}</span></span>)}
        </div>
      )}
      <PriceSettingsDialog open={pricesOpen} onClose={() => setPricesOpen(false)} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 价格表 / 预算编辑
// ---------------------------------------------------------------------------

export function PriceSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [prices, setPrices] = useState<ModelPrice[]>([]);
  const [rate, setRate] = useState(0);
  const [monthly, setMonthly] = useState('');
  const [perNovel, setPerNovel] = useState('');

  useEffect(() => {
    if (!open) return;
    void (async () => {
      setPrices(await effectivePrices());
      setRate(await getUsdToCnyRate());
      const b = await getBudget();
      setMonthly(b.monthlyCny == null ? '' : String(b.monthlyCny));
      setPerNovel(b.perNovelCny == null ? '' : String(b.perNovelCny));
    })();
  }, [open]);

  const patch = (id: string, p: Partial<ModelPrice>) => setPrices((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));

  const save = async (row: ModelPrice) => {
    await upsertPrice({ providerKind: row.providerKind, model: row.model, inputPerMTok: row.inputPerMTok, outputPerMTok: row.outputPerMTok, currency: row.currency });
    setPrices(await effectivePrices());
    toast.success(`已保存 ${row.model} 的价格`);
  };
  const reset = async (row: ModelPrice) => {
    await resetPrice(row.id);
    setPrices(await effectivePrices());
  };
  const saveGlobals = async () => {
    await setUsdToCnyRate(rate);
    await setBudget({
      monthlyCny: monthly.trim() === '' ? null : Math.max(0, Number(monthly)),
      perNovelCny: perNovel.trim() === '' ? null : Math.max(0, Number(perNovel)),
    });
    toast.success('已保存');
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} title="价格与预算" subtitle={`内置价格取自各供应商公开定价页（${BUILTIN_PRICE_AS_OF}），仅作默认值，请按你的实际账单核对`} width="max-w-3xl">
      <div className="space-y-5">
        <div className="grid grid-cols-3 gap-4">
          <Field label="美元折人民币汇率"><Input type="number" step="0.01" value={rate} onChange={(e) => setRate(Number(e.target.value))} /></Field>
          <Field label="每月上限（元）" hint="留空表示不限"><Input type="number" min={0} value={monthly} onChange={(e) => setMonthly(e.target.value)} /></Field>
          <Field label="单本上限（元）" hint="留空表示不限"><Input type="number" min={0} value={perNovel} onChange={(e) => setPerNovel(e.target.value)} /></Field>
        </div>
        <div className="max-h-80 overflow-y-auto rounded-2xl bg-paper-100/70 p-2 dark:bg-paper-900/70">
          <table className="w-full text-xs">
            <thead className="text-ink-400">
              <tr>
                <th className="px-2 py-1 text-left font-normal">模型</th>
                <th className="px-2 py-1 text-right font-normal">输入 / 百万</th>
                <th className="px-2 py-1 text-right font-normal">输出 / 百万</th>
                <th className="px-2 py-1 text-left font-normal">币种</th>
                <th className="px-2 py-1" />
              </tr>
            </thead>
            <tbody>
              {prices.map((p) => (
                <tr key={p.id} className="border-t border-paper-300/40 dark:border-paper-800">
                  <td className="px-2 py-1">
                    <span className="font-serif text-ink-800 dark:text-paper-100">{p.model}</span>
                    {p.source === 'user' && <span className="ml-1.5 text-[10px] text-cinnabar-600 dark:text-cinnabar-200">已改</span>}
                  </td>
                  <td className="px-2 py-1"><Input className="h-7 text-right" type="number" step="0.01" min={0} value={p.inputPerMTok} onChange={(e) => patch(p.id, { inputPerMTok: Number(e.target.value) })} /></td>
                  <td className="px-2 py-1"><Input className="h-7 text-right" type="number" step="0.01" min={0} value={p.outputPerMTok} onChange={(e) => patch(p.id, { outputPerMTok: Number(e.target.value) })} /></td>
                  <td className="px-2 py-1">
                    <Select className="h-7" value={p.currency} onChange={(e) => patch(p.id, { currency: e.target.value as PriceCurrency })}>
                      <option value="CNY">元</option>
                      <option value="USD">美元</option>
                    </Select>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-right">
                    <Button size="sm" variant="ghost" onClick={() => save(p)}>保存</Button>
                    {p.source === 'user' && <Button size="sm" variant="ghost" title="恢复内置价格" onClick={() => reset(p)}><RotateCcw size={13} strokeWidth={1.75} /></Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={saveGlobals}>保存汇率与预算</Button>
        </div>
      </div>
    </Dialog>
  );
}
