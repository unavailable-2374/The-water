import { threadRelevantAt } from '@/novel/threadPlanning';
import { sha256Hex, emptyBible, type StoryBible, type StorylineDoc } from '@the-water/shared';
import { getNovel, type Novel } from '@/db/repos/novelsRepo';
import { buildStorylineDoc, latestSnapshot } from '@/db/repos/storylineRepo';
import { bibleBeforeChapter } from '@/db/repos/bibleRepo';
import { getChapter, getVersion, listChapters, type Chapter, type ChapterVersion } from '@/db/repos/chaptersRepo';
import { assembleChapterContext, buildContextBudget, renderChapterPlan, renderChapterTitles, selectRelevantBible, mergeLoreSettings } from '@/llm/prompts/context';
import { genreLoreSettings, mergedGenreOf } from '@/novel/genrePacks';
import { systemBase, type StyleExtras } from '@/llm/prompts/base';
import { renderStyleUserBlock } from '@/llm/prompts/style';
import { guessSceneType } from '@/novel/styleMetrics';
import type { SceneType } from '@the-water/shared';
import type { LLMProvider } from '@/llm/types';
import type { StepContext } from '../context';
import { chapterDependencies, listWritingCards, retrieveCanonEvents } from '@/db/repos/writingRepo';
import { AwaitingReviewError } from '../awaitingReview';
import { estimateTokens } from '@/llm/tokens';
import { getDb } from '@/db/db';
import { setStepInput } from '@/db/repos/jobsRepo';
import { committedStoryProgress } from '@/db/repos/reviewsRepo';
import { docTypeGuide } from '@/novel/docTypes';
import { authorNoteOf, primeAuthorNote } from '@/llm/prompts/authorNote';
import { getStoryGraph, assertStoryTextEdit } from '@/db/repos/storyGraphRepo';

export interface ChapterEnv {
  novel: Novel;
  chapter: Chapter;
  doc: StorylineDoc;
  bible: StoryBible;
  snapshotId: string | null;
  chapters: Chapter[];
}

export async function loadChapterEnv(ctx: StepContext): Promise<ChapterEnv> {
  const novel = await getNovel(ctx.job.novelId);
  if (!novel) throw new Error('小说不存在');
  // 预热作者附加指令的同步缓存，供下面同步的 styleExtrasOf 取用。
  await primeAuthorNote(novel.id);
  const chapterId = ctx.step.chapterId;
  if (!chapterId) throw new Error('步骤缺少章节');
  const chapter = await getChapter(chapterId);
  if (!chapter) throw new Error('章节不存在');
  if (docTypeGuide(novel.requirements.docType).fiction) {
    const invalid = await getDb().select<{ id: string; chapter_no: number }>("SELECT id,chapter_no FROM chapters WHERE novel_id=? AND chapter_no<? AND archived_at IS NULL AND committed_version_id IS NOT NULL AND memory_status<>'valid' ORDER BY chapter_no LIMIT 1", [novel.id, chapter.chapterNo]);
    if (invalid[0]) throw new AwaitingReviewError(`第 ${invalid[0].chapter_no} 章记忆尚未重建，请按顺序审查并提交前文`, {kind:'memory',chapterId:invalid[0].id,chapterNo:invalid[0].chapter_no});
  }
  const deps = await chapterDependencies(novel.id, chapter.chapterNo);
  const candidate = chapter.currentVersionId ? await getVersion(chapter.currentVersionId):null;
  if (['write_chapter','write_scenes','rewrite_chapter','adjust_length'].includes(ctx.step.kind)) await assertStoryTextEdit(novel.id,chapter.id,candidate?.content ?? '',0,candidate?.content.length ?? 0);
  const candidateHash = candidate ? await sha256Hex(candidate.content):null;
  const saved = ctx.step.input.dependencyHash;
  if (saved && (ctx.step.input.candidateVersionId !== chapter.currentVersionId || ctx.step.input.candidateHash !== candidateHash) && !(candidate?.jobStepId === ctx.step.id || candidate?.jobStepId?.startsWith(`${ctx.step.id}#`))) throw new AwaitingReviewError('步骤候选正文已变化，请重新审查或重新生成');
  if (saved && saved !== deps.hash) throw new AwaitingReviewError('步骤输入依赖已变化，请重新审查或重新生成');
  if (!saved) {
    ctx.step.input = { ...ctx.step.input, dependencyHash: deps.hash, candidateVersionId: chapter.currentVersionId, candidateHash };
    await setStepInput(ctx.step.id, ctx.step.input);
  }
  const doc = await buildStorylineDoc(novel.id, novel.premise, novel.meta.themes);
  const bible = (await bibleBeforeChapter(novel.id, chapter.chapterNo))?.bible ?? emptyBible();
  const snap = await latestSnapshot(novel.id);
  const chapters = await listChapters(novel.id);
  return { novel, chapter, doc, bible, snapshotId: snap?.id ?? null, chapters };
}

/** Style profile / derivative declaration / source title for the prose system prompt. */
export function styleExtrasOf(env: Pick<ChapterEnv, 'novel' | 'doc'>): StyleExtras {
  return {
    profile: env.doc.styleProfile,
    derivative: env.doc.derivative,
    sourceTitle: env.novel.origin?.sourceTitle ?? null,
    authorNote: authorNoteOf(env.novel.id),
  };
}

/** Scene type for picking exemplars: opening/ending by position, otherwise guessed from the plan text. */
export function sceneTypeOf(env: Pick<ChapterEnv, 'chapter' | 'doc' | 'chapters'>): SceneType {
  const n = env.chapter.chapterNo;
  if (n === 1) return 'opening';
  if (env.chapters.length > 1 && n === env.chapters.at(-1)!.chapterNo) return 'ending';
  const plan = env.doc.chapters.find((p) => p.chapterNo === n);
  const text = plan ? [plan.goal, plan.endHook, ...(plan.beatIds.map((id) => env.doc.beats.find((b) => b.id === id)?.summary ?? ''))].join('。') : '';
  if (/(高潮|决战|摊牌|生死)/.test(text)) return 'climax';
  if (/(真相|揭|发现|得知)/.test(text)) return 'reveal';
  return guessSceneType(text);
}

export interface ChapterContextOptions {
  /** 上下文预算降档系数（见 @/llm/contextBudget），1 表示不降档。 */
  scale?: number;
  /** Stable IDs of the required evidence actually placed in the prompt. */
  onSources?: (ids: string[]) => void;
  /** 额外预留 token：json_object 模式注入的 schema。 */
  reserved?: number;
}

/** Build the budgeted user context text for writing/rewriting a chapter. */
export async function buildChapterContextText(env: ChapterEnv, provider: LLMProvider, maxTokens: number, opts: ChapterContextOptions = {}): Promise<string> {
  const { novel, chapter, doc, bible, chapters } = env;
  const n = chapter.chapterNo;
  const plans = doc.chapters;
  const current = plans.find((p) => p.chapterNo === n);
  const near = plans.filter((p) => (p.chapterNo >= n - 2 && p.chapterNo < n) || p.chapterNo === n + 1).sort((a, b) => a.chapterNo - b.chapterNo);
  const far = plans.filter((p) => !near.includes(p) && p.chapterNo !== n);
  const summaries: string[] = [];
  let prevTail = '';
  for (const c of chapters) {
    if (c.chapterNo >= n) break;
    if (!c.committedVersionId || c.chapterNo < n - 2) continue;
    const v = await getVersion(c.committedVersionId);
    if (!v) continue;
    if (v.summary) summaries.push(`第${c.chapterNo}章《${c.title}》：${v.summary}`);
    if (c.chapterNo === n - 1) prevTail = v.content.slice(-800);
  }
  const arcSummaries = Object.entries(bible.arcSummaries)
    .map(([arcId, s]) => { const arc = doc.arcs.find((a) => a.id === arcId); return `${arc ? `「${arc.title}」` : ''}${s}`; })
    .join('\n');
  const genreLore = genreLoreSettings(mergedGenreOf(novel.requirements));
  const requiredRules=mergeLoreSettings(doc.settings,genreLore).filter(s=>s.constant || s.kind==='rule');
  const rel = selectRelevantBible(bible, doc, n, [...summaries.slice(-2), prevTail].join('\n'), genreLore);
  const cards = await listWritingCards(novel.id, { confirmed: true, context:{chapterId:chapter.id,chapterNo:n} });
  const scenes = cards.filter(c => c.kind === 'scene' && c.chapterId === chapter.id);
  const characterIds = new Set([...(current?.povCharacterId ? [current.povCharacterId] : []), ...scenes.flatMap(c => c.kind === 'scene' ? c.data.characterIds : []), ...doc.beats.filter(b => current?.beatIds.includes(b.id)).flatMap(b => b.characterIds)]);
  const scenePlans=scenes.flatMap(c=>c.kind==='scene' ? [c.data]:[]);
  const scheduledThreadIds = cards.filter(c => c.kind === 'thread' && threadRelevantAt(c.data,n)).map(c => c.id);
  const facts = await retrieveCanonEvents(novel.id, n, {characterIds:[...characterIds],threadIds:[...new Set([...scheduledThreadIds,...scenePlans.flatMap(s=>s.threadIds)])],dependencyIds:scenePlans.flatMap(s=>s.dependencyIds),times:scenePlans.map(s=>s.time),locations:scenePlans.map(s=>s.location)});
  const readerProgress = docTypeGuide(novel.requirements.docType).fiction ? await committedStoryProgress(novel.id,n) : null;
  const { graph } = await getStoryGraph(novel.id);
  const nodeIds = new Set([...scenes.map(c => c.id), ...(current?.beatIds ?? [])]);
  if(scenePlans.some(scene=>scene.dependencyIds.some(id=>!facts.some(f=>f.id===id)))) throw new AwaitingReviewError('场景引用的必需事实已失效或尚未重建，请核对依赖来源');
  const relevantCards = cards.filter(c => c.kind === 'brief' || c.kind === 'volume' && c.data.startChapterNo <= n && c.data.endChapterNo >= n || c.kind === 'scene' && c.chapterId === chapter.id || c.kind === 'character' && characterIds.has(c.data.characterId) || c.kind === 'thread' && (threadRelevantAt(c.data,n) || scenes.some(s => s.kind === 'scene' && s.data.threadIds.includes(c.id))));
  opts.onSources?.([...relevantCards.map(c => c.id), ...doc.characters.filter(c => characterIds.size === 0 || characterIds.has(c.id)).map(c => c.id), ...requiredRules.map(s => s.id), ...facts.flatMap(f => [f.id, f.versionId])]);
  const required = docTypeGuide(novel.requirements.docType).fiction ? [
    '已确认计划（未来约束，不是已发生事实）：' + JSON.stringify(relevantCards),
    '跨章伏笔纪律：只推进当前章 milestones 指定阶段；未到 payoff 章不得揭示完整答案；埋设后保持因果与人物知情边界，未来阶段不是已发生事实。无里程碑的旧伏笔保持未确定，不自行编造回收时间。',
    '故事时间、事件因果与知情计划（未来约束，不是正文事实；未确定项保持留白）：' + JSON.stringify({ nodes:graph.nodes.filter(x=>nodeIds.has(x.id)), relations:graph.relations.filter(r=>r.status==='confirmed' && (nodeIds.has(r.from)||nodeIds.has(r.to))), secrets:graph.secrets, growth:graph.growth.filter(g=>characterIds.has(g.characterId)) }),
    '作者确认的叙述与对白偏好：' + JSON.stringify(graph.preferences.confirmed ? graph.preferences : {}),
    '人物设定（动机与红线）：' + JSON.stringify(doc.characters.filter(c => characterIds.size === 0 || characterIds.has(c.id))),
    '本书已确认规则：' + JSON.stringify(requiredRules.filter(s => doc.settings.some(own => own.id === s.id))),
    '题材创作指导（非已确认事实，不能单独据此报事实冲突）：' + JSON.stringify(requiredRules.filter(s => !doc.settings.some(own => own.id === s.id))),
    '正文已证实事实及人物知识（来源为版本 ID / UTF-16 位置）：' + JSON.stringify(facts),
    '前文已提交版本的故事推进与期待回应（AI编辑判断，有原文证据；不是读者反馈。沿用期待 ID，已兑现成果不得无依据撤回；未来计划不是兑现）：' + JSON.stringify(readerProgress),
  ].join('\n') : '';
  const baseBudget = buildContextBudget({ caps: provider.caps, maxTokens, scale: opts.scale, reserved: opts.reserved });
  const requiredTokens = estimateTokens(required, provider.caps.cjkTokenRatio);
  if (requiredTokens + estimateTokens(current ? renderChapterPlan(current, doc) : '', provider.caps.cjkTokenRatio) + estimateTokens(systemBase(novel.requirements, styleExtrasOf(env)), provider.caps.cjkTokenRatio) > baseBudget) throw new AwaitingReviewError('必需设定和证据超出模型窗口，请使用更大窗口的模型');
  const budget = baseBudget - requiredTokens;
  const style = doc.styleProfile ? renderStyleUserBlock(doc.styleProfile, sceneTypeOf(env)) : '';
  const { userText } = assembleChapterContext(
    {
      system: systemBase(novel.requirements, styleExtrasOf(env)),
      style,
      chapterPlans: { current: current ? renderChapterPlan(current, doc) : `第${n}章`, near: near.map((p) => renderChapterPlan(p, doc)), farTitles: renderChapterTitles(far) },
      bible: rel,
      recentSummaries: summaries,
      arcSummaries,
      prevTail,
      logline: novel.meta.logline,
    },
    budget,
    provider.caps.cjkTokenRatio,
  );
  return [required, userText].filter(Boolean).join('\n\n');
}

export async function currentVersionOf(chapter: Chapter): Promise<ChapterVersion | null> {
  return chapter.currentVersionId ? getVersion(chapter.currentVersionId) : null;
}

export function arcIdForChapter(doc: StorylineDoc, chapterNo: number): string | null {
  return doc.arcs.find((a) => a.startChapterNo <= chapterNo && chapterNo <= a.endChapterNo)?.id ?? null;
}

/**
 * 一个步骤里产出多个版本时，每个 pass 用自己的幂等键（§2.1 第 7 条）。
 * `adjust_length` 最多跑两轮扩写，崩在两轮之间时，靠这个键才认得出第二轮没跑完。
 */
export function passKey(stepId: string, pass: number): string {
  return `${stepId}#${pass}`;
}
