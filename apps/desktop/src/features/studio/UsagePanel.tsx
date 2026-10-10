/**
 * 用量与费用面板（§2.1 第 3 条）。
 *
 * token 用量本来就逐条落库了，只是从没聚合展示过。这里给出三层视图：
 * 每个任务 / 每本书 / 每月，外加一份可编辑的单位价格表和预算上限。
 * 开工前的费用预估也在这里（`previewCost`），供规划页与创建向导复用。
 */
import { useState } from 'react';
import { Coins, Pencil, RotateCcw } from 'lucide-react';
import { fmt, t } from '@/i18n';
import { Button, Card, Dialog, Field, IconButton, Input, Select, cn } from '@/components/ui';
import { useAsyncData } from '@/components/data/useAsyncData';
import { toast } from '@/components/Toast';
import {
  budgetReport, effectivePrices, getBudget, getUsdToCnyRate, resetPrice, setBudget, setUsdToCnyRate,
  upsertPrice, usageByMonth, usageByPurpose, usageTotals, monthStart, USAGE_PURPOSE_LABELS,
  type UsageGroup, type UsagePurpose, type UsageTotals,
} from '@/db/repos/usageRepo';
import {
  BUILTIN_PRICE_AS_OF, costOfUsage, addUsage, emptyUsage, estimateCost, formatCny, matchPrice,
  type ChapterEstimate, type ModelPrice, type PriceCurrency,
} from '@/novel/pricing';
import { getNovelProviders } from '@/novel/service';
import { providersForPurposes } from '@/jobs/runner';
import type { StepPurpose, StepProviderMap } from '@/jobs/purposes';
import type { Usage } from '@/llm/types';

// ---------------------------------------------------------------------------
// 费用预估
// ---------------------------------------------------------------------------

export interface CostPreview {
  usage: Usage;
  minimumCalls?:number;maximumCalls?:number;
  costCny: number;
  /** 至少命中了一条价格；否则界面上要说明「未配置价格」。 */
  priced: boolean;
  writingModel: string;
  auxiliaryModel: string;
}

/** 按将要使用的模型 + 当前价格表，把 token 估算折成钱。 */
export async function previewCost(estimate: ChapterEstimate, providerIds: StepProviderMap): Promise<CostPreview> {
  const [prices, rate] = await Promise.all([effectivePrices(), getUsdToCnyRate()]);
  if(estimate.byPurpose && Object.keys(estimate.byPurpose).length) {
    const purposes=Object.keys(estimate.byPurpose) as StepPurpose[];
    const map=await providersForPurposes({params:{providerIds},providerId:providerIds.writing ?? null},purposes).catch(()=>({} as Awaited<ReturnType<typeof providersForPurposes>>));
    let usage=emptyUsage(),costCny=0,priced=true;
    for(const purpose of purposes) {
      const provider=map[purpose],tokens=estimate.byPurpose[purpose]!;
      const full={...tokens,outputTokens:tokens.outputTokens+(provider?.caps.reasoningTokens ?? 0)*(estimate.calls?.[purpose] ?? 0)};
      const price=provider ? matchPrice(prices,provider.model,provider.kind):null;
      if((full.inputTokens+full.outputTokens)>0 && !price) priced=false;
      usage=addUsage(usage,full);costCny+=costOfUsage(full,price,rate);
    }
    return {usage,costCny,priced,writingModel:map.writing?.model ?? '',auxiliaryModel:map.summarize?.model ?? '',minimumCalls:estimate.minimumCalls,maximumCalls:estimate.maximumCalls};
  }
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
export function CostEstimateLine({ preview, prefix = t.studio.usage.estimatePrefix }: { preview: CostPreview | null; prefix?: string }) {
  if (!preview) return null;
  const { usage, costCny, priced } = preview;
  return (
    <p className="text-xs leading-relaxed text-ink-500">
      {preview.minimumCalls!==undefined && <span>{preview.minimumCalls}–{preview.maximumCalls} {t.studio.workbench.calls} · </span>}
      {prefix} <span className="font-serif text-ink-700 dark:text-ink-200">{kilo(usage.inputTokens)}</span>{t.studio.usage.estimateInput}
      <span className="font-serif text-ink-700 dark:text-ink-200">{kilo(usage.outputTokens)}</span>{t.studio.usage.estimateOutput}
      {priced
        ? <>{t.studio.usage.estimateCost}<span className="font-serif text-cinnabar-700 dark:text-cinnabar-100">{formatCny(costCny)}</span></>
        : <> · <span className="text-amber-700 dark:text-amber-300">{t.studio.usage.estimateUnpriced}</span></>}
      <span className="text-ink-400">{t.studio.usage.estimateDisclaimer}</span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// 用量卡片
// ---------------------------------------------------------------------------

const usageAmount = (totals: UsageTotals) => totals.unpricedCalls ? t.studio.usage.amountUnknown : formatCny(totals.costCny);

function StatCard({ label, totals, hint }: { label: string; totals: UsageTotals; hint?: string }) {
  return (
    <div className="rounded-2xl bg-paper-100/70 px-4 py-3 dark:bg-paper-900/70">
      <div className="text-[11px] tracking-wide text-ink-500">{label}</div>
      <div className="mt-1 font-serif text-xl tracking-wide text-ink-900 dark:text-paper-100">{usageAmount(totals)}</div>
      <div className="mt-0.5 text-[11px] text-ink-400">
        {fmt(t.studio.usage.callsLine, { calls: totals.calls, input: kilo(totals.inputTokens), output: kilo(totals.outputTokens) })}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-400">{hint}</div>}
    </div>
  );
}

interface UsageSnapshot {
  job: UsageTotals | null;
  novel: UsageTotals;
  month: UsageTotals;
  byPurpose: UsageGroup[];
  months: UsageGroup[];
  budget: Awaited<ReturnType<typeof budgetReport>>;
}

export function UsageCards({ novelId, jobId, tick }: { novelId: string; jobId?: string | null; tick?: number }) {
  const [pricesOpen, setPricesOpen] = useState(false);

  // 价格表改完关掉对话框也要重算，所以 `pricesOpen` 进 key。
  const { data } = useAsyncData<UsageSnapshot>(async () => {
    const [job, novel, month, byPurpose, months, budget] = await Promise.all([
      jobId ? usageTotals({ jobId }) : Promise.resolve(null),
      usageTotals({ novelId }),
      usageTotals({ since: monthStart() }),
      usageByPurpose({ novelId }),
      usageByMonth(6),
      budgetReport(novelId),
    ]);
    return { job, novel, month, byPurpose, months, budget };
  }, { key: `usage:${novelId}:${jobId ?? ''}:${tick ?? 0}:${pricesOpen}` });

  const budget = data?.budget ?? null;
  const over = budget && (budget.monthly.level === 'over' || budget.perNovel?.level === 'over');
  const warn = budget && !over && (budget.monthly.level === 'warn' || budget.perNovel?.level === 'warn');

  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-2">
        <Coins size={15} strokeWidth={1.75} className="text-ink-400" aria-hidden="true" />
        <h3 className="font-sans text-sm tracking-tight text-ink-800 dark:text-paper-100">{t.studio.usage.title}</h3>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setPricesOpen(true)}><Pencil size={13} strokeWidth={1.75} aria-hidden="true" />{t.studio.usage.editPrices}</Button>
      </div>
      {budget && (over || warn) && (
        <div role={over ? 'alert' : 'status'} className={cn('rounded-xl px-3 py-2 text-xs leading-relaxed', over ? 'bg-cinnabar-50 text-cinnabar-700 dark:bg-cinnabar-900/30 dark:text-cinnabar-100' : 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-200')}>
          {budget.monthly.level !== 'off' && fmt(t.studio.usage.monthlySpent, { spent: formatCny(budget.monthly.spent), limit: formatCny(budget.monthly.limit!) })}
          {budget.perNovel && budget.perNovel.level !== 'off' && fmt(t.studio.usage.novelSpent, { spent: formatCny(budget.perNovel.spent), limit: formatCny(budget.perNovel.limit!) })}
          {over ? t.studio.usage.over : t.studio.usage.warn}
        </div>
      )}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-2">
        {data?.job && <StatCard label={t.studio.usage.thisJob} totals={data.job} />}
        {data?.novel && <StatCard label={t.studio.usage.thisNovel} totals={data.novel} />}
        {data?.month && <StatCard label={t.studio.usage.thisMonth} totals={data.month} />}
      </div>
      {data && [data.job,data.novel,data.month].some(total=>total?.unpricedCalls) && <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">{t.studio.usage.estimateUnpriced}</p>}
      {data && data.byPurpose.length > 0 && (
        <ul aria-label={t.studio.usage.byPurpose} className="space-y-1 text-[11px] text-ink-500">
          {data.byPurpose.map((g) => (
            <li key={g.key} className="flex items-baseline gap-2">
              <span className="w-16 shrink-0">{USAGE_PURPOSE_LABELS[g.key as UsagePurpose] ?? g.key}</span>
              <span className="font-serif text-ink-700 dark:text-ink-200">{usageAmount(g)}</span>
              <span className="text-ink-400">{fmt(t.studio.usage.purposeLine, { calls: g.calls, tokens: kilo(g.inputTokens + g.outputTokens) })}</span>
            </li>
          ))}
        </ul>
      )}
      {data && data.months.length > 1 && (
        <div aria-label={t.studio.usage.monthsList} className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-400">
          {data.months.map((m) => <span key={m.key}>{m.key} <span className="font-serif text-ink-600 dark:text-ink-300">{usageAmount(m)}</span></span>)}
        </div>
      )}
      <PriceSettingsDialog open={pricesOpen} onClose={() => setPricesOpen(false)} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 价格表 / 预算编辑
// ---------------------------------------------------------------------------

interface PriceSettings { prices: ModelPrice[]; rate: number; monthly: string; perNovel: string }

export function PriceSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, setData } = useAsyncData<PriceSettings>(async () => {
    const [prices, rate, b] = await Promise.all([effectivePrices(), getUsdToCnyRate(), getBudget()]);
    return {
      prices, rate,
      monthly: b.monthlyCny == null ? '' : String(b.monthlyCny),
      perNovel: b.perNovelCny == null ? '' : String(b.perNovelCny),
    };
  }, { key: 'priceSettings', enabled: open });

  const patchAll = (p: Partial<PriceSettings>) => setData((prev) => ({ ...(prev ?? { prices: [], rate: 0, monthly: '', perNovel: '' }), ...p }));
  const patch = (id: string, p: Partial<ModelPrice>) =>
    setData((prev) => (prev ? { ...prev, prices: prev.prices.map((r) => (r.id === id ? { ...r, ...p } : r)) } : { prices: [], rate: 0, monthly: '', perNovel: '' }));

  const save = async (row: ModelPrice) => {
    await upsertPrice({ providerKind: row.providerKind, model: row.model, inputPerMTok: row.inputPerMTok, outputPerMTok: row.outputPerMTok, currency: row.currency });
    patchAll({ prices: await effectivePrices() });
    toast.success(fmt(t.studio.usage.priceSaved, { model: row.model }));
  };
  const reset = async (row: ModelPrice) => {
    await resetPrice(row.id);
    patchAll({ prices: await effectivePrices() });
  };
  const saveGlobals = async () => {
    if (!data) return;
    await setUsdToCnyRate(data.rate);
    await setBudget({
      monthlyCny: data.monthly.trim() === '' ? null : Math.max(0, Number(data.monthly)),
      perNovelCny: data.perNovel.trim() === '' ? null : Math.max(0, Number(data.perNovel)),
    });
    toast.success(t.studio.usage.saved);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} title={t.studio.usage.pricesTitle} subtitle={fmt(t.studio.usage.pricesSubtitle, { asOf: BUILTIN_PRICE_AS_OF })} width="max-w-3xl">
      <div className="space-y-5">
        <div className="grid grid-cols-3 gap-4">
          <Field label={t.studio.usage.rate}><Input type="number" step="0.01" value={data?.rate ?? 0} onChange={(e) => patchAll({ rate: Number(e.target.value) })} /></Field>
          <Field label={t.studio.usage.monthlyLimit} hint={t.studio.usage.limitHint}><Input type="number" min={0} value={data?.monthly ?? ''} onChange={(e) => patchAll({ monthly: e.target.value })} /></Field>
          <Field label={t.studio.usage.novelLimit} hint={t.studio.usage.limitHint}><Input type="number" min={0} value={data?.perNovel ?? ''} onChange={(e) => patchAll({ perNovel: e.target.value })} /></Field>
        </div>
        <div className="max-h-80 overflow-y-auto rounded-2xl bg-paper-100/70 p-2 dark:bg-paper-900/70">
          <table className="w-full text-xs">
            <thead className="text-ink-400">
              <tr>
                <th className="px-2 py-1 text-left font-normal">{t.studio.usage.colModel}</th>
                <th className="px-2 py-1 text-right font-normal">{t.studio.usage.colInput}</th>
                <th className="px-2 py-1 text-right font-normal">{t.studio.usage.colOutput}</th>
                <th className="px-2 py-1 text-left font-normal">{t.studio.usage.colCurrency}</th>
                <th className="px-2 py-1" />
              </tr>
            </thead>
            <tbody>
              {(data?.prices ?? []).map((p) => (
                <tr key={p.id} className="border-t border-paper-300/40 dark:border-paper-800">
                  <td className="px-2 py-1">
                    <span className="font-serif text-ink-800 dark:text-paper-100">{p.model}</span>
                    {p.source === 'user' && <span className="ml-1.5 text-[10px] text-cinnabar-600 dark:text-cinnabar-200">{t.studio.usage.edited}</span>}
                  </td>
                  <td className="px-2 py-1"><Input aria-label={`${p.model} ${t.studio.usage.colInput}`} className="h-7 text-right" type="number" step="0.01" min={0} value={p.inputPerMTok} onChange={(e) => patch(p.id, { inputPerMTok: Number(e.target.value) })} /></td>
                  <td className="px-2 py-1"><Input aria-label={`${p.model} ${t.studio.usage.colOutput}`} className="h-7 text-right" type="number" step="0.01" min={0} value={p.outputPerMTok} onChange={(e) => patch(p.id, { outputPerMTok: Number(e.target.value) })} /></td>
                  <td className="px-2 py-1">
                    <Select aria-label={`${p.model} ${t.studio.usage.colCurrency}`} className="h-7" value={p.currency} onChange={(e) => patch(p.id, { currency: e.target.value as PriceCurrency })}>
                      <option value="CNY">{t.studio.usage.cny}</option>
                      <option value="USD">{t.studio.usage.usd}</option>
                    </Select>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-right">
                    <Button size="sm" variant="ghost" onClick={() => save(p)}>{t.common.save}</Button>
                    {p.source === 'user' && <IconButton label={t.studio.usage.resetPrice} className="inline-flex align-middle" onClick={() => reset(p)}><RotateCcw size={13} strokeWidth={1.75} aria-hidden="true" /></IconButton>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button variant="primary" onClick={saveGlobals}>{t.studio.usage.saveGlobals}</Button>
        </div>
      </div>
    </Dialog>
  );
}
