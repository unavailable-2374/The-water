/**
 * 写作层（novel/*）的可调常量总表 —— §2.3 第 4 条。
 *
 * 收敛范围：**只收 novel 层的写作常量**（字数预算、lint 阈值、文体统计、
 * 学习层、故事圣经上限、拆书批大小、风格审校）。
 * 不收 LLM 传输层的参数：超时、JSON 修复轮次、上下文降档系数在 `@/llm/config.ts`，
 * 那是 LLM 层的事，两边不要合并。
 * 也不收 `llm/prompts/context.ts` 的上下文分节预算（SECTION_CAPS）——
 * 那是提示词装配层，与这里的写作口径无关。
 *
 * 约定：本文件是这些数字的**唯一出处**；`wordBudget.ts` / `lint.ts` / `bible.ts` 等
 * 仍然对外 re-export 原来的名字，改值只改这里。
 *
 * 每个值都标注了「含义」与「调大 / 调小会发生什么」，便于以后调参时不用翻代码。
 */

// ---------------------------------------------------------------------------
// 一、字数预算（wordBudget.ts）
// ---------------------------------------------------------------------------

export const WORD_BUDGET = {
  /** 没有指定时每章的默认目标字数。调大 → 章少而长，模型更容易写崩；调小 → 章多，任务与费用变多。 */
  defaultCharsPerChapter: 3000,
  /** 自动排章节数的下限。太小会让长篇被压成几章。 */
  minChapters: 3,
  /** 自动排章节数的上限。调大 → 单本任务步骤数线性增长，费用与耗时同步上升。 */
  maxChapters: 150,
  /** 重分配预算时，单章目标不得低于此值。低于这个字数的章节读起来像残章。 */
  minChapterTarget: 500,
  /** 目标高于这个值的章节拆成前后两半写。调大 → 少拆分但更容易触到模型输出上限而被截断。 */
  splitChapterThreshold: 4500,
  /** 实际字数低于 目标×该比例 时触发扩写。调大 → 更爱扩写，费用上升。 */
  expandBelowRatio: 0.88,
  /** 实际字数高于 目标×该比例 时触发精简。调小 → 更爱精简，容易削掉有效情节。 */
  trimAboveRatio: 1.2,
  /** 向模型要的字数是目标的这个倍数（模型普遍写不够）。调大 → 更容易超字数后再精简，多花一次调用。 */
  askRatio: 1.08,
  /** 「勉强可接受」的下限比例，写进提示词的「不得少于 N 字」。 */
  minAcceptableRatio: 0.9,
  /** 重分配剩余预算时，单章新目标相对原目标的夹紧幅度（±30%）。调大 → 后面的章节长短起伏更大。 */
  redistributeClamp: 0.3,
  /** 输出上限公式 min(maxOutputTokens, ceil(target×倍率)+余量) 中的倍率。 */
  maxTokensRatio: 1.6,
  /** 上述公式的固定余量 token。 */
  maxTokensSlack: 400,
} as const;

// ---------------------------------------------------------------------------
// 二、本地质检 lint（lint.ts）
// ---------------------------------------------------------------------------

export const LINT = {
  /** 少于这么多字就不跑结构类规则（句长起伏、段落均匀度等），样本太小结论没意义。 */
  minCharsForStructure: 600,
  /** 句长起伏（标准差/均值）低于此值判「像机器写的」。调大 → 更严，误报增多。 */
  burstinessWarn: 0.3,
  /** 段长起伏低于此值判「过于工整」。 */
  paragraphUniformWarn: 0.25,
  /** 跑句长起伏至少要有这么多句。 */
  minSentencesForBurstiness: 15,
  /** 跑段落均匀度至少要有这么多段。 */
  minParagraphsForUniformity: 6,
  /** 小标题式开头的段落占比达到此值即报「段段都是小标题」。 */
  headedParagraphRatio: 0.5,
  /** 出现这么多个 emoji 列表符号即报。 */
  emojiBulletMin: 2,
  /** 同一段里同一个双字词重复达到此次数即报（且该段短于 wordRepeatParaMax）。 */
  wordRepeatMin: 4,
  /** 只在短于此长度的段落里查词语重复；长段里重复是正常的。 */
  wordRepeatParaMax: 400,
  /** 单条规则最多记录几处命中，避免一份报告被同一个词刷屏。 */
  maxHitsPerRule: 5,
  /** 单个词最多扫描几次出现位置（性能上限）。 */
  maxScanPerNeedle: 50,
  /** AI 味分 = 100 − 命中率(每千字) × 该系数。调大 → 分数更容易被扣到 0。 */
  aiTellPenaltyPerK: 12,
  /** lintIssuesToInstructions 默认最多产出几条修订意见。 */
  maxInstructions: 8,
} as const;

// ---------------------------------------------------------------------------
// 三、文体统计（styleMetrics.ts）
// ---------------------------------------------------------------------------

export const STYLE_METRICS = {
  /** n-gram 指纹保留前 N 个高频词组。调大 → 指纹更细但更容易混进普通搭配。 */
  ngramTop: 12,
  /** 词组至少出现这么多次才进指纹。 */
  ngramMinCount: 3,
  /** 词组频率（次数/总字数）至少要到这个比例才进指纹。 */
  ngramMinRatio: 0.0004,
  /** 指标比对时，硬性指标（targets.hard）的扣分权重倍数。调大 → 硬指标一超就掉分很快。 */
  hardMetricWeight: 1.5,
  /** 场景猜测：对白占比高于此值判为对白场。 */
  dialogueSceneRatio: 0.4,
  /** 场景猜测：动作用字密度高于此值判为打斗场。 */
  fightSceneRatio: 0.008,
  /** 场景猜测：对白占比低于此值判为静场。 */
  quietSceneRatio: 0.15,
} as const;

// ---------------------------------------------------------------------------
// 四、学习层（learning.ts）
// ---------------------------------------------------------------------------

export const LEARNING = {
  /** 同一短语被用户删掉这么多次后自动晋升为「少用词」。调小 → 学得快但更容易学到偶然删除。 */
  promoteThreshold: 2,
  /** 提取被删短语时的 n-gram 最短长度（汉字数）。 */
  minPhraseLen: 2,
  /** n-gram 最长长度。调大 → 学到的短语更长更具体，但更难再次命中。 */
  maxPhraseLen: 6,
  /** 作品负面清单（软禁用）最多保留多少条，超出丢弃最早的。 */
  softNegativeCap: 100,
} as const;

// ---------------------------------------------------------------------------
// 五、故事圣经上限（bible.ts）
// ---------------------------------------------------------------------------

export const BIBLE_CAPS = {
  /** 时间线保留最近多少条事件。调小 → 长篇后期会忘掉早期事件。 */
  timeline: 5000,
  /** 既定事实条数上限。 */
  facts: 1000,
  /** 未了线索条数上限。 */
  openThreads: 500,
  /** 单个人物保留的关系描述条数上限。 */
  relationships: 50,
} as const;

// ---------------------------------------------------------------------------
// 六、拆书 extract_style（jobs/steps/extractStyleStep.ts）
// ---------------------------------------------------------------------------

export const EXTRACT_STYLE = {
  /** 每批喂给模型的节选总字数。调大 → 批次少但单次上下文更贵，也更容易超窗。 */
  batchChars: 9000,
  /** 最多跑几批（费用上限）。调大 → 拆得更准，费用线性上升。 */
  maxBatches: 4,
  /** 每章取正文开头多少字作为节选。 */
  excerptPerChapter: 3000,
  /** 全书最多采样多少章（前三章 + 均匀分布）。 */
  sampleChapters: 8,
} as const;

// ---------------------------------------------------------------------------
// 七、风格审校 style_check（jobs/steps/styleCheckStep.ts）
// ---------------------------------------------------------------------------

/** 用户可调的风格审校参数（§2.3 第 3 条）。存在 settings 表的 `styleCheck` 键。 */
export interface StyleCheckConfig {
  /**
   * 未达标时最多定点修订几轮（0 = 只审不改，直接记录未达标）。
   * 调大 → 更可能改到达标，但每一轮都是一次写作模型调用，费用与耗时同步上升。
   */
  maxRevisions: number;
  /**
   * 没有二创声明时的默认风格相似度要求。及格线 = 该值 × 100。
   * 调大 → 更严，未达标章节变多；低于 0.5 基本等于不审。
   */
  defaultFidelity: number;
  /** 综合分里 LLM 评分的权重，其余给本地指标分。调大 → 更信模型的主观打分。 */
  llmScoreWeight: number;
  /** 一次定点修订最多喂几条意见。调大 → 一次改得多，但模型容易顾此失彼。 */
  maxInstructions: number;
}

export const DEFAULT_STYLE_CHECK: StyleCheckConfig = {
  maxRevisions: 1,
  defaultFidelity: 0.75,
  llmScoreWeight: 0.6,
  maxInstructions: 12,
};

/** 风格审校参数的取值范围（UI 与规整都用这一份）。 */
export const STYLE_CHECK_LIMITS = {
  maxRevisions: [0, 3] as const,
  defaultFidelity: [0.5, 1] as const,
  llmScoreWeight: [0, 1] as const,
  maxInstructions: [3, 20] as const,
};

const clampTo = (n: unknown, [lo, hi]: readonly [number, number], fallback: number): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  return Math.min(hi, Math.max(lo, v));
};

/** 把任意来源（settings 表里的旧值、手改的 JSON）规整成合法配置。纯函数。 */
export function normalizeStyleCheck(raw: unknown): StyleCheckConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof StyleCheckConfig, unknown>>;
  return {
    maxRevisions: Math.round(clampTo(o.maxRevisions, STYLE_CHECK_LIMITS.maxRevisions, DEFAULT_STYLE_CHECK.maxRevisions)),
    defaultFidelity: clampTo(o.defaultFidelity, STYLE_CHECK_LIMITS.defaultFidelity, DEFAULT_STYLE_CHECK.defaultFidelity),
    llmScoreWeight: clampTo(o.llmScoreWeight, STYLE_CHECK_LIMITS.llmScoreWeight, DEFAULT_STYLE_CHECK.llmScoreWeight),
    maxInstructions: Math.round(clampTo(o.maxInstructions, STYLE_CHECK_LIMITS.maxInstructions, DEFAULT_STYLE_CHECK.maxInstructions)),
  };
}

/** settings 表里存风格审校配置的键。 */
export const STYLE_CHECK_SETTING_KEY = 'styleCheck';

/**
 * 读取风格审校配置。动态 import settingsRepo，避免把 DB 依赖带进
 * lint / styleMetrics 这些纯模块的静态依赖图。
 */
export async function loadStyleCheckConfig(): Promise<StyleCheckConfig> {
  const { getSetting } = await import('@/db/repos/settingsRepo');
  return normalizeStyleCheck(await getSetting<unknown>(STYLE_CHECK_SETTING_KEY, {}));
}

export async function saveStyleCheckConfig(patch: Partial<StyleCheckConfig>): Promise<StyleCheckConfig> {
  const { getSetting, setSetting } = await import('@/db/repos/settingsRepo');
  const next = normalizeStyleCheck({ ...normalizeStyleCheck(await getSetting<unknown>(STYLE_CHECK_SETTING_KEY, {})), ...patch });
  await setSetting(STYLE_CHECK_SETTING_KEY, next);
  return next;
}
