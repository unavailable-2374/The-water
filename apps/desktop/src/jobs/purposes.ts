/**
 * 按步骤用途分配模型（§2.1 第 2 条）。
 *
 * 原来所有步骤都走 `providerForPurpose('writing')`：总结、风格审校、设定校对、拆书
 * 这些「读得多、写得少」的活儿也在用最贵的写作模型。这里把步骤归到六种用途上，
 * 每种用途可以单独指定供应商：
 *
 *   写作层（贵）：writing —— 写章、扩写/精简、改写、定点修订
 *   规划层（中）：planning —— 大纲、章节表、改写说明
 *   校读层（便宜）：summarize / styleReview / consistency / extractStyle
 *
 * 选择结果有三个来源，优先级从高到低：
 *   1. 任务参数 `params.providerIds`（创建任务时冻结下来的选择，向导第三步就是改这个）
 *   2. 任务的 `provider_id` 列（只对 writing 生效，等价于「这个任务用哪个写作模型」）
 *   3. 全局设置 `stepProviderId`
 * 三者都没有时，回落到 `llm/registry` 的三档默认（写作 / 规划）。
 */
import type { StepKind } from '@/db/repos/jobsRepo';
import type { UsagePurpose } from '@/db/repos/usageRepo';
import type { ProviderPurpose } from '@/llm/registry';

export type StepPurpose = Exclude<UsagePurpose, 'chat'>;

export const STEP_PURPOSES: readonly StepPurpose[] = ['writing', 'planning', 'summarize', 'styleReview', 'consistency', 'extractStyle'];

export const STEP_PURPOSE_LABELS: Record<StepPurpose, string> = {
  writing: '写作与改写', planning: '大纲与章节表', summarize: '章节总结', styleReview: '文风审校', consistency: '设定校对', extractStyle: '拆书提取',
};

/** 每种用途在界面上的一句话说明，帮助用户判断该配强模型还是便宜模型。 */
export const STEP_PURPOSE_HINTS: Record<StepPurpose, string> = {
  writing: '正文由它写，最影响质量，建议用最好的模型',
  planning: '人物、故事弧、章节表，中档模型足够',
  summarize: '把写完的章节压成摘要，用便宜模型',
  styleReview: '给章节打文风分、找 OOC，用便宜模型',
  consistency: '核对数值、时间线与设定，用便宜模型',
  extractStyle: '从既有正文里提取文风档案，用便宜模型',
};

export const STEP_PURPOSE: Record<StepKind, StepPurpose> = {
  outline: 'planning',
  chapter_table: 'planning',
  write_chapter: 'writing',
  adjust_length: 'writing',
  rewrite_chapter: 'writing',
  // 纯本地字符串替换，不调模型；归到 writing 只是为了让映射保持全覆盖。
  name_replace: 'writing',
  summarize: 'summarize',
  style_check: 'styleReview',
  extract_style: 'extractStyle',
};

/** 回落到 registry 现有的三档：写作用途走 writing，其余都走 planning（便宜档）。 */
export function basePurposeOf(purpose: StepPurpose): ProviderPurpose {
  return purpose === 'writing' ? 'writing' : 'planning';
}

export type StepProviderMap = Partial<Record<StepPurpose, string | null>>;

export interface ProviderSources {
  /** 任务创建时冻结的选择。 */
  job?: StepProviderMap | null;
  /** 全局设置。 */
  global?: StepProviderMap | null;
  /** 任务的 provider_id 列，只对 writing 生效。 */
  jobProviderId?: string | null;
}

/** 纯函数：按优先级挑出该用途要用的供应商 id，都没有则 null（交给 registry 兜底）。 */
export function pickProviderId(purpose: StepPurpose, sources: ProviderSources): string | null {
  const fromJob = sources.job?.[purpose];
  if (fromJob) return fromJob;
  if (purpose === 'writing' && sources.jobProviderId) return sources.jobProviderId;
  const fromGlobal = sources.global?.[purpose];
  if (fromGlobal) return fromGlobal;
  return null;
}

/** 从任务参数里读出用途 → 供应商映射（脏数据一律忽略）。 */
export function providerMapOf(params: Record<string, unknown> | null | undefined): StepProviderMap {
  const raw = params?.providerIds;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: StepProviderMap = {};
  for (const p of STEP_PURPOSES) {
    const v = (raw as Record<string, unknown>)[p];
    if (typeof v === 'string' && v) out[p] = v;
  }
  return out;
}

/** 只保留有值的项，用来存进任务参数 / 设置里。 */
export function cleanProviderMap(map: StepProviderMap | null | undefined): StepProviderMap {
  const out: StepProviderMap = {};
  for (const p of STEP_PURPOSES) {
    const v = map?.[p];
    if (typeof v === 'string' && v) out[p] = v;
  }
  return out;
}
