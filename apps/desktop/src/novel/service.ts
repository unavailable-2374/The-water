/**
 * Studio service：建任务 + 少量同步操作。
 *
 * 大纲与章节表原来跑在前台（§2.1 第 1 条），现在一律走后台任务步骤
 * （`jobs/steps/outlineStep.ts` / `chapterTableStep.ts`），这里只负责建任务、
 * 按用途冻结模型选择（§2.1 第 2 条）以及开工前的预算检查（§2.1 第 3 条）。
 */
import { emptyDerivative, splitChapters, type DerivativeDecl, type StyleProfile } from '@the-water/shared';
import { emptyBible } from '@the-water/shared';
import { createNovel, getNovel, updateNovel, type Novel } from '@/db/repos/novelsRepo';
import { buildStorylineDoc, createSnapshot, getStyleExtras, setDerivative, setStyleProfile } from '@/db/repos/storylineRepo';
import { beginRewriteSession, createVersion, listChapters, markStaleFrom, resolveAllRewrites, resolveRewrite, upsertChapterPlan } from '@/db/repos/chaptersRepo';
import { saveBible } from '@/db/repos/bibleRepo';
import { BLOCKING_JOB_STATUSES, createJob, listJobs, type Job } from '@/db/repos/jobsRepo';
import { getSetting, setSetting } from '@/db/repos/settingsRepo';
import { assertBudget } from '@/db/repos/usageRepo';
import type { NovelRequirements } from '@/novel/types';
import { storylineToOutline } from '@/novel/planning';
import { planGenerate, planPlanning, planRegenerate, planRewrite, planStyleCheck, type PlannedStep, type RewriteItemInput } from '@/jobs/planner';
import { cleanProviderMap, type StepProviderMap } from '@/jobs/purposes';
import { profileFromFreeText } from '@/novel/stylePresets';
import { isEmptyGenre, mergedGenreOf } from '@/novel/genrePacks';
import { kick } from '@/jobs/runner';
import { emitJobEvent } from '@/jobs/events';

export { storylineToOutline };

export interface WizardInput { title: string; premise: string; requirements: NovelRequirements; targetChars: number; styleProfile?: StyleProfile | null }

export async function createNovelFromWizard(input: WizardInput): Promise<Novel> {
  const novel = await createNovel({ title: input.title || '未命名小说', premise: input.premise, requirements: input.requirements, targetChars: input.targetChars, status: 'draft' });
  const profile = input.styleProfile ?? profileFromFreeText(input.requirements.style);
  if (profile) await setStyleProfile(novel.id, profile);
  return novel;
}

/**
 * Whether generated chapters should go through style_check: a derivative, a selected genre pack
 * （L1 自带禁忌词、靶区间与设定规则，够 style_check 干活了），or a profile with targets/voice.
 */
export async function wantsStyleCheck(novelId: string): Promise<boolean> {
  const { styleProfile, derivative } = await getStyleExtras(novelId);
  if (derivative) return true;
  const novel = await getNovel(novelId);
  if (novel && !isEmptyGenre(mergedGenreOf(novel.requirements))) return true;
  if (!styleProfile) return false;
  const hasVoice = Object.values(styleProfile.voice).some((v) => typeof v === 'object' && v !== null && 'text' in v && (v as { text: string }).text.trim().length > 0);
  return styleProfile.metrics !== null || hasVoice || styleProfile.exemplars.length > 0 || styleProfile.injection.humanReadableConstraints.length > 0;
}

async function ensureNoActiveJob(novelId: string): Promise<void> {
  const active = await listJobs({ novelId, statuses: [...BLOCKING_JOB_STATUSES] });
  if (active.length) throw new Error('该小说已有进行中的任务，请先完成或取消');
}

// ---------------------------------------------------------------------------
// 按用途选模型 + 预算检查（§2.1 第 2、3 条）
// ---------------------------------------------------------------------------

/** 每本书自己的模型选择存在设置表里（向导第三步 / 规划页写入）。 */
export const novelProviderKey = (novelId: string) => `novelProviders:${novelId}`;

export async function getNovelProviders(novelId: string): Promise<StepProviderMap> {
  return cleanProviderMap(await getSetting<StepProviderMap>(novelProviderKey(novelId), {}));
}
export async function setNovelProviders(novelId: string, map: StepProviderMap): Promise<void> {
  await setSetting(novelProviderKey(novelId), cleanProviderMap(map));
}

export interface StartOptions {
  /** 覆盖这本书已保存的模型选择（只影响这一个任务）。 */
  providerIds?: StepProviderMap;
  /** 已经向用户确认过费用超预算，照跑。 */
  ignoreBudget?: boolean;
}

/**
 * 建任务的统一入口：把「用途 → 供应商」的选择冻结进任务参数，
 * 这样任务跑到一半用户改了设置也不会换模型；`provider_id` 列存写作模型，
 * 任务池的供应商级并发数按它算。
 */
async function submitJob(input: { novelId: string; type: Job['type']; params: Record<string, unknown>; steps: PlannedStep[] }, opts: StartOptions = {}): Promise<Job> {
  const providerIds = cleanProviderMap({ ...(await getNovelProviders(input.novelId)), ...opts.providerIds });
  if (!opts.ignoreBudget) await assertBudget(input.novelId);
  return createJob({
    novelId: input.novelId,
    type: input.type,
    params: { ...input.params, providerIds },
    providerId: providerIds.writing ?? null,
    steps: input.steps,
  });
}

// ---------------------------------------------------------------------------
// 规划阶段：大纲 / 章节表（§2.1 第 1 条）
// ---------------------------------------------------------------------------

/** 重排章节表会删掉已有章节，必须先让用户确认。 */
export class ConfirmRequiredError extends Error {
  readonly chapterCount: number;
  constructor(chapterCount: number) {
    super(`重排章节表会替换已有的 ${chapterCount} 章（正文与版本历史都会一起删除），确定要继续吗？`);
    this.name = 'ConfirmRequiredError';
    this.chapterCount = chapterCount;
  }
}

export interface PlanningOptions extends StartOptions {
  /** 只跑大纲 / 只跑章节表，缺省两步都跑。 */
  outline?: boolean;
  chapterTable?: boolean;
  /** 用户已确认「重排会删掉已有章节」。 */
  confirmReplaceChapters?: boolean;
}

/**
 * 规划任务：大纲 → 章节表。走的是普通任务通道，所以可暂停、可恢复、
 * 崩溃后能接着跑，失败还能单步重试。
 */
export async function startPlanning(novelId: string, opts: PlanningOptions = {}): Promise<string> {
  await ensureNoActiveJob(novelId);
  const wantTable = opts.chapterTable !== false;
  if (wantTable && !opts.confirmReplaceChapters) {
    const existing = await listChapters(novelId);
    if (existing.length > 0) throw new ConfirmRequiredError(existing.length);
  }
  const steps = planPlanning({ outline: opts.outline, chapterTable: opts.chapterTable });
  if (steps.length === 0) throw new Error('没有需要执行的规划步骤');
  const job = await submitJob({ novelId, type: 'generate_novel', params: { stage: 'plan' }, steps }, opts);
  await updateNovel(novelId, { status: 'planning' });
  kick();
  return job.id;
}

/** 只生成大纲。 */
export const startOutline = (novelId: string, opts: StartOptions = {}) => startPlanning(novelId, { ...opts, chapterTable: false });
/** 只排章节表（已有章节时需要 confirmReplaceChapters）。 */
export const startChapterTable = (novelId: string, opts: Omit<PlanningOptions, 'outline' | 'chapterTable'> = {}) => startPlanning(novelId, { ...opts, outline: false });

/** 这个任务是不是「规划」任务（大纲 / 章节表），用于界面上区分标题。 */
export function isPlanningJob(job: Pick<Job, 'params'>): boolean {
  return (job.params as { stage?: unknown }).stage === 'plan';
}


/** Start writing all unwritten chapters (or a subset). */
export async function startGeneration(novelId: string, opts: { only?: number[]; force?: boolean } & StartOptions = {}): Promise<string> {
  await ensureNoActiveJob(novelId);
  const chapters = await listChapters(novelId);
  const steps = planGenerate(chapters, { force: opts.force, only: opts.only ? new Set(opts.only) : undefined, styleCheck: await wantsStyleCheck(novelId) });
  if (steps.length === 0) throw new Error('没有需要生成的章节');
  const job = await submitJob({ novelId, type: 'generate_novel', params: { only: opts.only ?? null }, steps }, opts);
  await updateNovel(novelId, { status: 'generating' });
  kick();
  return job.id;
}

export async function regenerateChapter(novelId: string, chapterNo: number, opts: { cascade?: boolean } & StartOptions = {}): Promise<string> {
  await ensureNoActiveJob(novelId);
  const chapters = await listChapters(novelId);
  const target = chapters.find((c) => c.chapterNo === chapterNo);
  if (!target) throw new Error('章节不存在');
  const following = opts.cascade ? chapters.filter((c) => c.chapterNo > chapterNo && c.currentVersionId) : [];
  if (!opts.cascade) await markStaleFrom(novelId, chapterNo + 1, '上游章节已重新生成');
  const job = await submitJob({ novelId, type: 'regenerate_chapter', params: { chapterNo, cascade: !!opts.cascade }, steps: planRegenerate(target, following, { styleCheck: await wantsStyleCheck(novelId) }) }, opts);
  kick();
  return job.id;
}

export async function startRewrite(novelId: string, items: RewriteItemInput[], snapshotBeforeId: string | null, opts: StartOptions = {}): Promise<string> {
  await ensureNoActiveJob(novelId);
  const novel = await getNovel(novelId);
  if (!novel) throw new Error('小说不存在');
  const steps = planRewrite(items, { styleCheck: await wantsStyleCheck(novelId) });
  if (steps.length === 0) throw new Error('没有选中任何章节');
  // 改写前先把现在的故事线存一版：reason 用 pre_rewrite（与 §2.1 章节表重建路径同义
  // ——破坏性操作之前的自动存档），改写产出的版本引用的就是它。§2.2 第 4 条。
  const doc = await buildStorylineDoc(novelId, novel.premise, novel.meta.themes);
  await createSnapshot(novelId, doc, 'pre_rewrite');
  const job = await submitJob({ novelId, type: 'rewrite', params: { snapshotBeforeId, chapterNos: items.map((i) => i.chapter.chapterNo) }, steps }, opts);
  // 记下每一章改写前的正文与状态：产出先落「待采纳」，作者逐章取舍，
  // 「撤销这次改写」就是全部回到这些基线（§2.2 第 1、4 条）。
  await beginRewriteSession(items.map((i) => i.chapter.id), job.id);
  kick();
  return job.id;
}

/** 逐章采纳 / 丢弃改写结果。丢弃 = 撤销这一章的改写，回到改写前的正文与状态。 */
export async function resolveChapterRewrite(chapterId: string, action: 'accept' | 'discard'): Promise<void> {
  await resolveRewrite(chapterId, action);
}
/** 一键把整本书待采纳的改写全部采纳。 */
export const acceptAllRewrites = (novelId: string): Promise<number> => resolveAllRewrites(novelId, 'accept');
/** 一键撤销这次改写：所有待采纳的章节回到改写前的那一版。 */
export const undoRewrite = (novelId: string): Promise<number> => resolveAllRewrites(novelId, 'discard');

/** 拆书：从现有正文提取文风档案 + 人物言行规格 + 规矩（后台任务）。 */
export async function startStyleExtraction(novelId: string, opts: StartOptions = {}): Promise<string> {
  await ensureNoActiveJob(novelId);
  const job = await submitJob({ novelId, type: 'extract_style', params: {}, steps: [{ kind: 'extract_style', chapterId: null, input: {} }] }, opts);
  kick();
  return job.id;
}

/** 单章审校（不改写流程，只出报告并在不达标时定点修订一次）。 */
export async function startStyleCheck(novelId: string, chapterNo: number, opts: StartOptions = {}): Promise<string> {
  await ensureNoActiveJob(novelId);
  const chapter = (await listChapters(novelId)).find((c) => c.chapterNo === chapterNo);
  if (!chapter) throw new Error('章节不存在');
  if (!chapter.currentVersionId) throw new Error('这一章还没有正文');
  const job = await submitJob({ novelId, type: 'style_check', params: { chapterNo }, steps: planStyleCheck(chapter) }, opts);
  kick();
  return job.id;
}

export async function saveDerivative(novelId: string, decl: DerivativeDecl | null): Promise<void> {
  await setDerivative(novelId, decl);
  emitJobEvent({ type: 'novel:storylineUpdated', novelId });
}

export async function saveStyleProfile(novelId: string, profile: StyleProfile | null): Promise<void> {
  await setStyleProfile(novelId, profile);
  emitJobEvent({ type: 'novel:storylineUpdated', novelId });
}

export { emptyDerivative };

/** Import a plain-text novel (split by 第X章) as imported chapter versions; storyline can be inferred later. */
export async function importTextNovel(input: { title: string; text: string; requirements: NovelRequirements }): Promise<Novel> {
  const parts = splitChapters(input.text);
  const total = parts.reduce((s, p) => s + p.content.length, 0);
  const novel = await createNovel({ title: input.title, premise: '', requirements: input.requirements, targetChars: total, status: 'writing' });
  let n = 1;
  for (const p of parts) {
    const ch = await upsertChapterPlan(novel.id, { chapterNo: n++, title: p.title, targetChars: p.content.length });
    await createVersion({ chapterId: ch.id, content: p.content, source: 'imported', status: 'final' });
  }
  await saveBible(novel.id, 0, emptyBible());
  return novel;
}
