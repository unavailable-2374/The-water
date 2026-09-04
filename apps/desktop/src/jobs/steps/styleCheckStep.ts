/**
 * style_check（docs/writing/README.md §5.4–§5.5）：写章后、提交前的三条独立通道
 *   1. 机器：本地 metrics 与目标区间比对 + lint（AI 味 / 题材负面清单 / 作品负面清单）
 *   2. LLM 风格审校：六维风格评分 + 逐句 OOC（需要 StyleProfile）
 *   3. LLM 设定校对：数值 / 时间线 / 称呼 / 设定规则（不需要 StyleProfile，有可对照材料才调用）
 * 通道按职能而不是按题材划分：题材差异只是喂进来的数据（题材包 L1）不同。
 * 不通过时定点修订（revise 模式，只喂问题清单）再测一次，轮数与及格线可在
 * 「设置 → 通用 → 风格审校」里调（`novel/config.ts` 的 StyleCheckConfig）。
 * 跑满轮数仍未达标时不再强行通过：review.verdict 保持 revise，章节列表会标「风格未达标」。
 */
import { countZh } from '@the-water/shared';
import { createVersion, setChapterStatus } from '@/db/repos/chaptersRepo';
import { findReviewByStep, saveReview, type ChapterReviewJson } from '@/db/repos/reviewsRepo';
import { requestJson } from '@/llm/json';
import { completeWithRetry } from '@/llm/complete';
import { withContextDowngrade } from '@/llm/contextBudget';
import { styleReviewPrompt, reviewToInstructions, type StyleReviewResult } from '@/llm/prompts/styleReview';
import { consistencyIssueCount, consistencyReviewPrompt, consistencyToInstructions, hasConsistencyMaterial, type ConsistencyResult } from '@/llm/prompts/consistencyReview';
import { mergeLoreSettings } from '@/llm/prompts/context';
import { rewriteChapterPrompt } from '@/llm/prompts/rewriteChapter';
import { compareMetrics, computeStyleMetrics } from '@/novel/styleMetrics';
import { lintIssuesToInstructions, lintText } from '@/novel/lint';
import { docTypeGuide } from '@/novel/docTypes';
import { applyGenreToProfile, genreLoreSettings, genreTargets, isEmptyGenre, mergedGenreOf } from '@/novel/genrePacks';
import { maxTokensForChapter } from '@/novel/wordBudget';
import { loadStyleCheckConfig, type StyleCheckConfig } from '@/novel/config';
import { primeAuthorNote, authorNoteOf } from '@/llm/prompts/authorNote';
import { emitJobEvent } from '../events';
import { joinResumed, resumePrefix, withResumeSeed } from '../resume';
import type { Usage } from '@/llm/types';
import type { StepHandler } from '../context';
import { buildChapterContextText, currentVersionOf, loadChapterEnv, styleExtrasOf, type ChapterEnv } from './common';

interface Assessment { report: ChapterReviewJson; styleScore: number; oocCount: number; verdict: 'pass' | 'revise'; instructions: string[] }

async function assess(env: ChapterEnv, text: string, ctx: Parameters<StepHandler>[0], cfg: StyleCheckConfig): Promise<Assessment> {
  const { doc, novel, chapter, bible } = env;
  const guide = docTypeGuide(novel.requirements.docType);
  // L1 题材层只补作品没写的部分；作品层（doc.styleProfile）永远优先。
  const genre = mergedGenreOf(novel.requirements);
  const profile = applyGenreToProfile(doc.styleProfile, genre);
  const metrics = computeStyleMetrics([text]);
  const targets = profile ? profile.targets : genreTargets(genre);
  const cmp = profile || !isEmptyGenre(genre) ? compareMetrics(metrics, targets) : { score: 100, findings: [], hardViolations: [] };
  const lint = lintText(text, { profile, genre });
  const metricHints = cmp.findings.map((f) => f.hint);
  const lintHints = lintIssuesToInstructions(lint, 5);
  // 三层合并后的设定：作品层同名条目覆盖题材层。
  const settings = mergeLoreSettings(doc.settings, genreLoreSettings(genre));
  const ownIds = new Set(doc.settings.map((s) => s.id));
  const canonRules = settings.filter((s) => s.kind === 'rule' || s.constant);
  const qcReminders = [...guide.qc, ...genre.qc];

  let llm: StyleReviewResult | null = null;
  if (profile) {
    ctx.setMessage(`正在审校第 ${chapter.chapterNo} 章的文风与人物`);
    const canonFacts = [...bible.facts.slice(-20), ...canonRules.map((s) => `${s.name}：${s.description}`)];
    const spec = styleReviewPrompt({
      chapterNo: chapter.chapterNo, chapterText: text, profile, characters: doc.characters, derivative: doc.derivative,
      sourceTitle: novel.origin?.sourceTitle ?? null, canonFacts, metricHints: [...metricHints, ...lintHints], qcReminders,
    });
    const r = await requestJson(ctx.provider, { ...spec, schema: spec.schema! }, { signal: ctx.signal, gate: ctx.gate, onDelta: (_d, acc) => ctx.onDelta(acc) });
    await ctx.recordUsage(r.usage, { purpose: 'styleReview' });
    llm = r.value;
  }

  // 设定校对：与风格审校相互独立的一条职能通道，不需要 StyleProfile；没有可对照的材料就不调用。
  let consistency: ConsistencyResult | null = null;
  if (guide.fiction) {
    const cInput = {
      chapterNo: chapter.chapterNo,
      chapterText: text,
      facts: bible.facts.slice(-30),
      rules: canonRules.map((s) => ({ name: s.name, description: s.description, scope: (ownIds.has(s.id) ? '本书' : '题材') as '本书' | '题材' })),
      timeline: bible.timeline.filter((e) => e.chapterNo < chapter.chapterNo).slice(-15).map((e) => `第${e.chapterNo}章：${e.event}`),
      characters: doc.characters,
      qcReminders,
    };
    if (hasConsistencyMaterial(cInput)) {
      ctx.setMessage(`正在校对第 ${chapter.chapterNo} 章的设定与时间线`);
      const spec = consistencyReviewPrompt(cInput);
      // 设定校对是独立职能，允许配一个更便宜的模型（§2.1 第 2 条）。
      const checker = await ctx.providerFor('consistency');
      const r = await requestJson(checker, { ...spec, schema: spec.schema! }, { signal: ctx.signal, gate: ctx.gate, onDelta: (_d, acc) => ctx.onDelta(acc) });
      await ctx.recordUsage(r.usage, { purpose: 'consistency', provider: checker });
      consistency = r.value;
    }
  }
  const consistencyHints = consistency ? consistencyToInstructions(consistency) : [];

  // 及格线：二创声明里的相似度优先；没有声明时用设置里的默认值（§2.3 第 3 条）。
  const fidelity = doc.derivative?.styleFidelity ?? cfg.defaultFidelity;
  const oocCount = llm ? llm.ooc.filter((o) => o.verdict === 'OOC').length : 0;
  const redlineHit = llm ? llm.ooc.some((o) => o.verdict === 'OOC' && o.redline.trim().length > 0) : false;
  const llmScore = llm ? llm.styleScore : 100;
  const styleScore = Math.round(llm ? llmScore * cfg.llmScoreWeight + cmp.score * (1 - cfg.llmScoreWeight) : cmp.score);
  const blockLint = lint.issues.some((i) => i.severity === 'block');
  const inconsistent = consistency !== null && consistencyIssueCount(consistency) > 0;
  const verdict: 'pass' | 'revise' =
    cmp.hardViolations.length > 0 || redlineHit || inconsistent || (llm ? llm.canonConflicts.length > 0 || llm.verdict === 'revise' || llmScore < fidelity * 100 : false) || blockLint ? 'revise' : 'pass';
  // 事实错误排在最前：定点修订的名额优先给它。
  const instructions = [...consistencyHints, ...(llm ? reviewToInstructions(llm, metricHints) : metricHints), ...lintHints].slice(0, cfg.maxInstructions);
  const report: ChapterReviewJson = {
    metricScore: cmp.score,
    metricFindings: cmp.findings.map((f) => ({ key: f.key, label: f.label, value: f.value, target: f.target, hard: f.hard, hint: f.hint })),
    lintIssues: lint.issues.slice(0, 40).map((i) => ({ rule: i.rule, severity: i.severity, message: i.message, quote: i.quote })),
    aiTellScore: lint.aiTellScore,
    llm,
    consistency,
    revisedVersionId: null,
    revisionInstructions: [],
  };
  return { report, styleScore, oocCount, verdict, instructions };
}

export const styleCheckStep: StepHandler = async (ctx) => {
  const existing = await findReviewByStep(ctx.step.id);
  if (existing) return { outputRef: existing.id };
  const cfg = await loadStyleCheckConfig();
  const env = await loadChapterEnv(ctx);
  const { chapter, novel } = env;
  // 作者附加指令（§2.3 第 6 条）：预热缓存后同步取用，拼进定点修订的 system 提示。
  await primeAuthorNote(novel.id);
  let version = await currentVersionOf(chapter);
  if (!version) throw new Error('章节尚无正文');
  // Nothing to check against and no AI review possible → still record lint so the UI can show it.
  let a = await assess(env, version.content, ctx, cfg);
  let revisions = 0;
  while (a.verdict === 'revise' && revisions < cfg.maxRevisions && a.instructions.length > 0) {
    revisions++;
    ctx.setMessage(`第 ${chapter.chapterNo} 章文风/人物未达标，正在定点修订第 ${revisions}/${cfg.maxRevisions} 轮（${a.instructions.length} 处）`);
    await setChapterStatus(chapter.id, 'generating');
    const target = chapter.targetChars || countZh(version.content) || 3000;
    // 定点修订是在写正文，用写作模型，不用审校用的便宜模型。
    const writer = await ctx.providerFor('writing');
    const maxTokens = maxTokensForChapter(target, writer.caps);
    const oldText = version.content;
    const seed = resumePrefix(ctx.takeResumeSeed());
    const { text, usage } = await withContextDowngrade<{ text: string; usage: Usage }>(
      async (scale) => {
        const contextUserText = await buildChapterContextText(env, writer, maxTokens, { scale });
        const spec = rewriteChapterPrompt({ chapterNo: chapter.chapterNo, requirements: novel.requirements, contextUserText, oldText, instructions: a.instructions, mode: 'revise', targetChars: target, caps: writer.caps, style: { ...styleExtrasOf(env), authorNote: authorNoteOf(novel.id) } });
        const { messages } = withResumeSeed(spec.messages, seed);
        const r = await completeWithRetry(writer, { messages, maxTokens: spec.maxTokens, temperature: spec.temperature, signal: ctx.signal }, { gate: ctx.gate, onDelta: (_d, acc) => ctx.onDelta(joinResumed(seed, acc)) });
        return { text: joinResumed(seed, r.text).trim(), usage: r.usage };
      },
      { onDowngrade: ({ nextScale }) => ctx.setMessage(`上下文超出模型窗口，已缩减到 ${Math.round(nextScale * 100)}% 重试第 ${chapter.chapterNo} 章`) },
    );
    await ctx.recordUsage(usage, { purpose: 'writing', provider: writer });
    if (countZh(text) < 50) break;
    const instructions = a.instructions;
    version = await createVersion({ chapterId: chapter.id, content: text, source: 'rewritten', summary: version.summary, storylineSnapshotId: env.snapshotId, jobStepId: ctx.step.id, model: writer.model, usage });
    emitJobEvent({ type: 'chapter:versionCreated', novelId: novel.id, chapterId: chapter.id, versionId: version.id });
    a = await assess(env, text, ctx, cfg);
    a.report.revisedVersionId = version.id;
    a.report.revisionInstructions = instructions;
  }
  const review = await saveReview({ novelId: novel.id, chapterId: chapter.id, chapterVersionId: version.id, styleScore: a.styleScore, oocCount: a.oocCount, verdict: a.verdict, report: a.report, jobStepId: ctx.step.id });
  emitJobEvent({ type: 'chapter:reviewed', novelId: novel.id, chapterId: chapter.id, reviewId: review.id });
  if ((ctx.step.input as { standalone?: boolean }).standalone) await setChapterStatus(chapter.id, chapter.status === 'final' ? 'final' : 'draft');
  return { outputRef: review.id };
};
