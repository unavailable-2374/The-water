import { z } from 'zod';
import { nanoid } from 'nanoid';
import { sys, user, systemBase, JSON_ONLY_RULE } from '@/llm/prompts/base';
import { wrapUntrusted } from '@/llm/prompts/untrusted';
import { applyRevisionPatches, RevisionPatchesSchema } from '@/novel/textProposals';
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
import { countZh, sha256Hex, anchorEvidence, type ReviewIssue } from '@the-water/shared';
import { beginRewriteSession, createVersion, setChapterStatus } from '@/db/repos/chaptersRepo';
import { getDb } from '@/db/db';
import { assertReviewPass, findReviewByStep, saveReview, type ChapterReviewJson } from '@/db/repos/reviewsRepo';
import { chapterDependencies } from '@/db/repos/writingRepo';
import { AwaitingReviewError } from '../awaitingReview';
import { locateNarrativeIssues, narrativeReviewPrompt, narrativeSourceError } from '@/llm/prompts/narrativeReview';
import { requestJson } from '@/llm/json';
import { LLMError } from '@/llm/types';
import { styleReviewPrompt, reviewToInstructions, type StyleReviewResult } from '@/llm/prompts/styleReview';
import { consistencyIssueCount, consistencyReviewPrompt, consistencyToInstructions, hasConsistencyMaterial, type ConsistencyResult } from '@/llm/prompts/consistencyReview';
import { mergeLoreSettings } from '@/llm/prompts/context';
import { compareMetrics, computeStyleMetrics } from '@/novel/styleMetrics';
import { lintIssuesToInstructions, lintText } from '@/novel/lint';
import { docTypeGuide } from '@/novel/docTypes';
import { applyGenreToProfile, genreLoreSettings, genreTargets, isEmptyGenre, mergedGenreOf } from '@/novel/genrePacks';
import { maxTokensForChapter } from '@/novel/wordBudget';
import { loadStyleCheckConfig, type StyleCheckConfig } from '@/novel/config';
import { primeAuthorNote } from '@/llm/prompts/authorNote';
import { emitJobEvent } from '../events';
import { locateStoryAssessment, storyRevisionIssues } from '@/novel/storyQuality';
import { readProseOnly } from '@/novel/firstReading';
import type { StepHandler } from '../context';
import { buildChapterContextText, currentVersionOf, loadChapterEnv, styleExtrasOf, type ChapterEnv } from './common';

interface Assessment { report: ChapterReviewJson; styleScore: number; oocCount: number; verdict: 'pass' | 'revise'; instructions: string[] }

async function assess(env: ChapterEnv, text: string, versionId: string, ctx: Parameters<StepHandler>[0], cfg: StyleCheckConfig): Promise<Assessment> {
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
  // Genre preparation guidance cannot become confirmed canon merely by selecting a pack.
  const canonRules = settings.filter((s) => ownIds.has(s.id) && (s.kind === 'rule' || s.constant));
  const qcReminders = [...guide.qc, ...genre.qc];

  let narrative: ReviewIssue[] = [];
  let story: ChapterReviewJson['story'];
  let lengthReview: ChapterReviewJson['lengthReview'];
  let firstReading: ChapterReviewJson['firstReading'];
  let readerAlignment: ChapterReviewJson['readerAlignment'];
  if (guide.fiction) {
    ctx.setMessage(`正在审查第 ${chapter.chapterNo} 章的情节、人物、展开与冗余`);
    const checker = await ctx.providerFor('consistency');
    ctx.setMessage(`正在首次阅读截至第 ${chapter.chapterNo} 章的正文`);
    const blind = await readProseOnly(novel.id, chapter.chapterNo, { id: versionId, content: text }, checker, { signal: ctx.signal, gate: ctx.gate });
    await ctx.recordUsage(blind.usage, { purpose: 'consistency', provider: checker });
    firstReading = blind.reading;
    const sourceIds = new Set<string>();
    const advisoryIds = new Set(genre.entries.filter(e => !ownIds.has(e.id)).map(e => e.id));
    const context = await buildChapterContextText(env, checker, 6000, { reserved: text.length * checker.caps.cjkTokenRatio, onSources: ids => ids.forEach(id => sourceIds.add(id)) });
    const spec = narrativeReviewPrompt({ chapterNo: chapter.chapterNo, text, context, qcReminders, firstReading });
    const result = await requestJson(checker, { ...spec, schema: spec.schema!.superRefine((value,check)=>{
      if (!value.lengthReview) check.addIssue({code:'custom',path:['lengthReview'],message:'新审查必须扫描整章并提供篇幅与场景完整性判断。'});
      for (const [index, item] of (value.readerAlignment ?? []).entries()) if (!item.sourceIds.length || item.sourceIds.some(id => !sourceIds.has(id) || advisoryIds.has(id))) check.addIssue({ code: 'custom', path: ['readerAlignment', index, 'sourceIds'], message: '作者意图必须引用已提供的本书确认资料，不能使用题材指导或编造 ID' });
      if (new Set(value.issues.map(issue => issue.id)).size !== value.issues.length) check.addIssue({code:'custom',path:['issues'],message:'审稿问题 ID 必须唯一。'});
      for (const [index, action] of (value.lengthReview?.actions ?? []).entries()) if (!value.issues.some(issue => issue.id === action.issueId)) check.addIssue({code:'custom',path:['lengthReview','actions',index,'issueId'],message:'篇幅建议必须引用本次 issues 中有原文依据的问题 ID。'});
      if (!value.story) check.addIssue({code:'custom',path:['story'],message:'新审查必须提供故事推进结果，不能只返回空问题列表。'});
      else {
        try { locateStoryAssessment(text,value.story); } catch { check.addIssue({code:'custom',path:['story'],message:'变化与兑现必须有本章唯一连续原文证据。'}); }
        if (value.story.verdict==='revise' && !value.issues.some(i=>['causality','motivation','knowledge','thread','ending','repetition'].includes(i.category))) check.addIssue({code:'custom',path:['story','verdict'],message:'revise 必须提供可定位的结构问题，不得凭一般文风偏好要求修订。'});
      }
      for(const [i,issue] of value.issues.entries()){const sourceError = narrativeSourceError(issue, sourceIds, advisoryIds); if(sourceError) check.addIssue({code:'custom',path:['issues',i,'sourceIds'],message:sourceError});try {anchorEvidence(text,{from:-1,to:-1,quote:issue.evidence.quote});} catch {check.addIssue({code:'custom',path:['issues',i,'evidence'],message:'quote 必须是当前正文中唯一的连续逐字原文，请重新选择证据。'});}}
    }) }, { signal: ctx.signal, gate: ctx.gate });
    await ctx.recordUsage(result.usage, { purpose: 'consistency', provider: checker });
    narrative = locateNarrativeIssues(text, result.value.issues);
    story = locateStoryAssessment(text,result.value.story!);
    lengthReview = result.value.lengthReview;
    readerAlignment = result.value.readerAlignment;
    for (const issue of narrative) { try { issue.evidence = anchorEvidence(text, issue.evidence); } catch { throw new AwaitingReviewError('审稿问题无法定位原文，请重新审查'); } }
  }
  let llm: StyleReviewResult | null = null;
  if (profile) {
    ctx.setMessage(`正在审校第 ${chapter.chapterNo} 章的文风与人物`);
    const canonFacts = [...bible.facts.slice(-20), ...canonRules.map((s) => `${s.name}：${s.description}`)];
    const spec = styleReviewPrompt({
      chapterNo: chapter.chapterNo, chapterText: text, profile, characters: doc.characters, derivative: doc.derivative,
      sourceTitle: novel.origin?.sourceTitle ?? null, canonFacts, metricHints: [...metricHints, ...lintHints], qcReminders,
    });
    // 审校结论是 JSON，不走正文预览通道（见 summarizeStep 的说明）。
    const r = await requestJson(ctx.provider, { ...spec, schema: spec.schema! }, { signal: ctx.signal, gate: ctx.gate });
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
      const r = await requestJson(checker, { ...spec, schema: spec.schema! }, { signal: ctx.signal, gate: ctx.gate });
      await ctx.recordUsage(r.usage, { purpose: 'consistency', provider: checker });
      consistency = r.value;
    }
  }
  const addConflict = (quote: string, basis: string, category: ReviewIssue['category']) => {
    try {
      const evidence = anchorEvidence(text, { from: -1, to: -1, quote });
      narrative.push({ id: `verified-${narrative.length}`, category, severity: 'block', evidence, basis: basis || '明确的设定冲突', suggestion: '依据所列设定修订此处，保留无关正文', sourceIds: [] });
    } catch { throw new AwaitingReviewError('审稿冲突无法定位原文，请重新审查'); }
  };
  if (consistency) for (const c of [...consistency.numericConflicts, ...consistency.loreConflicts, ...consistency.timelineConflicts]) addConflict(c.quote, `${c.against}：${c.why}`, 'canon');
  if (consistency) for (const c of consistency.addressErrors) addConflict(c.quote, `${c.character}的称呼应为${c.expected}：${c.why}`, 'voice');
  if (llm) for (const o of llm.ooc) if (o.verdict === 'OOC' && o.redline.trim()) addConflict(o.quote, `${o.character}：${o.redline}；${o.why}`, 'voice');
  const consistencyHints = consistency ? consistencyToInstructions(consistency) : [];

  // 及格线：二创声明里的相似度优先；没有声明时用设置里的默认值（§2.3 第 3 条）。
  const oocCount = llm ? llm.ooc.filter((o) => o.verdict === 'OOC').length : 0;
  const redlineHit = llm ? llm.ooc.some((o) => o.verdict === 'OOC' && o.redline.trim().length > 0) : false;
  const llmScore = llm ? llm.styleScore : 100;
  const styleScore = Math.round(llm ? llmScore * cfg.llmScoreWeight + cmp.score * (1 - cfg.llmScoreWeight) : cmp.score);
  const blockLint = lint.issues.some((i) => i.severity === 'block');
  const inconsistent = consistency !== null && consistencyIssueCount(consistency) > 0;
  const verdict: 'pass' | 'revise' = narrative.some(i => i.severity === 'block') || (!guide.fiction && (redlineHit || inconsistent || blockLint)) ? 'revise' : 'pass';
  // 事实错误排在最前：定点修订的名额优先给它。
  const instructions = [...narrative.filter(i => i.severity === 'block').map(i => `「${i.evidence.quote}」：${i.basis}；${i.suggestion}`), ...consistencyHints, ...(llm ? reviewToInstructions(llm, metricHints) : metricHints), ...lintHints].slice(0, cfg.maxInstructions);
  const report: ChapterReviewJson = {
    narrative,
    ...(firstReading ? { firstReading, readerAlignment } : {}),
    ...(story ? {story}:{}),
    ...(lengthReview ? {lengthReview}:{}),
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
  const cfg = await loadStyleCheckConfig();
  const env = await loadChapterEnv(ctx);
  const { chapter, novel } = env;
  // 作者附加指令（§2.3 第 6 条）：预热缓存后同步取用，拼进定点修订的 system 提示。
  await primeAuthorNote(novel.id);
  let version = await currentVersionOf(chapter);
  if (!version) throw new Error('章节尚无正文');
  let deps = await chapterDependencies(novel.id, chapter.chapterNo);
  if (existing && existing.chapterVersionId === version.id && existing.contentHash === await sha256Hex(version.content) && existing.dependencyHash === deps.hash && existing.valid && (!docTypeGuide(novel.requirements.docType).fiction || existing.report.lengthReview && existing.report.firstReading?.inferenceChecks)) {
    try {
      await assertReviewPass(existing.id, version.id, existing.contentHash, deps.hash);
      return { outputRef: existing.id };
    } catch (error) {
      // An explicit retry of an unresolved review requests a fresh assessment.
      // Passed or fully dismissed reviews remain reusable after crash recovery.
      if (!(error instanceof AwaitingReviewError)) throw error;
    }
  }
  // Nothing to check against and no AI review possible → still record lint so the UI can show it.
  let a = await assess(env, version.content, version.id, ctx, cfg);
  const persistReview=async(candidate:NonNullable<typeof version>,assessment:Awaited<ReturnType<typeof assess>>)=>{
    const saved=await saveReview({novelId:novel.id,chapterId:chapter.id,chapterVersionId:candidate.id,styleScore:assessment.styleScore,oocCount:assessment.oocCount,verdict:assessment.verdict,report:assessment.report,jobStepId:ctx.step.id,contentHash:await sha256Hex(candidate.content),dependencyHash:deps.hash});
    emitJobEvent({type:'chapter:reviewed',novelId:novel.id,chapterId:chapter.id,reviewId:saved.id});
    return saved;
  };
  // A failed revision request must not erase the evidence the author needs to act on.
  let review=await persistReview(version,a);
  const savedRounds = ctx.step.input.automaticRevisions;
  // Older in-flight tasks have no counter. Count their persisted revisions once;
  // the durable counter thereafter survives pruning, crashes and explicit retries.
  const [legacyRounds] = await getDb().select<{ count: number }>(
    "SELECT COUNT(*) AS count FROM chapter_versions WHERE job_step_id=? AND source='rewritten'", [ctx.step.id],
  );
  let revisions = Math.max(
    typeof savedRounds === 'number' && Number.isSafeInteger(savedRounds) && savedRounds >= 0 ? savedRounds : 0,
    legacyRounds?.count ?? 0,
  );
  if (savedRounds !== revisions) {
    await getDb().atomic([{sql:"UPDATE job_steps SET input=json_set(input,'$.automaticRevisions',?) WHERE id=?",params:[revisions,ctx.step.id],expectedRows:1}]);
    ctx.step.input.automaticRevisions = revisions;
  }
  while ((a.verdict === 'revise' || a.report.story?.verdict==='revise') && revisions < cfg.maxRevisions) {
    const nextRound = revisions + 1;
    const blocks=storyRevisionIssues(a.report.narrative ?? [],a.report.story).slice(0,cfg.maxInstructions);
    if(!blocks.length) break;
    ctx.setMessage(`第 ${chapter.chapterNo} 章正在修订人物、情节与因果，第 ${nextRound}/${cfg.maxRevisions} 轮（${blocks.length} 处问题）`);
    await setChapterStatus(chapter.id, 'generating', undefined, ctx.commit);
    const target = chapter.targetChars || countZh(version.content) || 3000;
    // 定点修订是在写正文，用写作模型，不用审校用的便宜模型。
    const writer = await ctx.providerFor('writing');
    const maxTokens = maxTokensForChapter(target, writer.caps);
    const oldText = version.content;
    const contextUserText=await buildChapterContextText(env,writer,maxTokens,{reserved:oldText.length*writer.caps.cjkTokenRatio});
    const schema=RevisionPatchesSchema.superRefine((value,check)=>{try{applyRevisionPatches(oldText,value.patches,blocks);}catch(error){check.addIssue({code:z.ZodIssueCode.custom,message:String(error)});}});
    const result=await requestJson(writer,{messages:[sys(`${systemBase(novel.requirements,styleExtrasOf(env))}\n你是局部修订编辑。先修复已定位的事实与知识冲突，再处理所列人物选择、因果缺环、重复场景和期待兑现问题。只修改这些明确列出的问题，不修改未列出的文风偏好。返回 patches 数组，每项有 from、to、original（连续逐字原文）、replacement。位置采用 UTF-16。每个补丁必须与至少一条所列问题的证据范围有实质交集；若修正同一问题还必须改相邻对白或衔接，将这些修改合并为一个覆盖该证据的连续局部补丁，中间无关原文逐字保留，不要另列未覆盖任何证据的补丁。补丁不得重叠，不得返回整章替换，不改无关段落；若根本矛盾无法局部解决，返回空数组等待作者处理。\n${JSON_ONLY_RULE}`),user(`${contextUserText}\n需要修订的问题：${JSON.stringify(blocks)}\n${wrapUntrusted('当前正文',oldText)}`)],schema,maxTokens,temperature:0.2,label:`局部修订第${chapter.chapterNo}章`},{signal:ctx.signal,gate:ctx.gate}).catch(async error=>{
      if(error instanceof LLMError && error.kind==='bad_request') {
        if(error.usage) await ctx.recordUsage(error.usage,{purpose:'writing',provider:writer});
        throw new AwaitingReviewError(`定点修订未完成，审稿问题已保存，请修改正文或重新审查：${error.message}`);
      }
      throw error;
    });
    await ctx.recordUsage(result.usage,{purpose:'writing',provider:writer});
    if(!result.value.patches.length) break;
    const {text,patches}=applyRevisionPatches(oldText,result.value.patches,blocks);
    ctx.onDelta(text);
    const instructions=blocks.map(i=>`「${i.evidence.quote}」：${i.basis}；${i.suggestion}`);
    const baseVersionId=version.id,baseHash=await sha256Hex(oldText);
    // A repair of approved prose stays a candidate until the author adopts it.
    if (chapter.committedVersionId) await beginRewriteSession([chapter.id],ctx.job.id,ctx.commit);
    version = await createVersion({ commit: ctx.commit, chapterId: chapter.id, expectedWorkingVersionId: version.id, expectedWorkingHash: version.contentHash, content: text, source: 'rewritten', summary: version.summary, storylineSnapshotId: env.snapshotId, jobStepId: ctx.step.id, model: writer.model, usage:result.usage,
      atomicTail:[...patches.map(p=>{const id=nanoid();return {sql:"INSERT INTO writing_proposals(id,novel_id,chapter_id,kind,state,json,created_at) VALUES (?,?,?,'text','accepted',?,?)",params:[id,novel.id,chapter.id,JSON.stringify({id,chapterId:chapter.id,baseVersionId,baseHash,operation:'rewrite',...p,sourceIds:[...new Set(blocks.flatMap(i=>i.sourceIds))]}),Date.now()]};}),
        {sql:"UPDATE job_steps SET input=json_set(input,'$.automaticRevisions',?) WHERE id=?",params:[nextRound,ctx.step.id],expectedRows:1}],
    });
    revisions = nextRound;
    ctx.step.input.automaticRevisions = revisions;
    emitJobEvent({ type: 'chapter:versionCreated', novelId: novel.id, chapterId: chapter.id, versionId: version.id });
    deps = await chapterDependencies(novel.id, chapter.chapterNo);
    a = await assess(env, text, version.id, ctx, cfg);
    a.report.revisedVersionId = version.id;
    a.report.revisionInstructions = instructions;
    review=await persistReview(version,a);
  }
  if ((ctx.step.input as { standalone?: boolean }).standalone) await setChapterStatus(chapter.id, chapter.status === 'final' ? 'final' : 'draft');
  if (a.report.story?.verdict==='replan') throw new AwaitingReviewError(`故事计划需要调整：${a.report.story.reason}。可在故事工作台的候选页生成跨章节结构修订方案，审阅采纳后编辑涉及章节、重建事实并复审。`,{kind:'chapter'});
  if (a.report.story?.verdict==='revise') throw new AwaitingReviewError(`故事推进仍不足：${a.report.story.reason}。正文和审查结果已保留，请修改后继续。`,{kind:'chapter'});
  if (a.verdict === 'revise') throw new AwaitingReviewError('自动修订后仍有阻断问题，请编辑正文、重新审查或记录误报依据');
  return { outputRef: review.id };
};
