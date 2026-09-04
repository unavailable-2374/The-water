import { emptyBible, type StoryBible, type StorylineDoc } from '@the-water/shared';
import { getNovel, type Novel } from '@/db/repos/novelsRepo';
import { buildStorylineDoc, latestSnapshot } from '@/db/repos/storylineRepo';
import { bibleBeforeChapter } from '@/db/repos/bibleRepo';
import { getChapter, getVersion, listChapters, type Chapter, type ChapterVersion } from '@/db/repos/chaptersRepo';
import { assembleChapterContext, buildContextBudget, renderChapterPlan, renderChapterTitles, selectRelevantBible } from '@/llm/prompts/context';
import { genreLoreSettings, mergedGenreOf } from '@/novel/genrePacks';
import { systemBase, type StyleExtras } from '@/llm/prompts/base';
import { renderStyleUserBlock } from '@/llm/prompts/style';
import { guessSceneType } from '@/novel/styleMetrics';
import type { SceneType } from '@the-water/shared';
import type { LLMProvider } from '@/llm/types';
import type { StepContext } from '../context';
import { authorNoteOf, primeAuthorNote } from '@/llm/prompts/authorNote';

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
    if (!c.currentVersionId) continue;
    const v = await getVersion(c.currentVersionId);
    if (!v) continue;
    if (v.summary) summaries.push(`第${c.chapterNo}章《${c.title}》：${v.summary}`);
    if (c.chapterNo === n - 1) prevTail = v.content.slice(-800);
  }
  const arcSummaries = Object.entries(bible.arcSummaries)
    .map(([arcId, s]) => { const arc = doc.arcs.find((a) => a.id === arcId); return `${arc ? `「${arc.title}」` : ''}${s}`; })
    .join('\n');
  const genreLore = genreLoreSettings(mergedGenreOf(novel.requirements));
  const rel = selectRelevantBible(bible, doc, n, [...summaries.slice(-2), prevTail].join('\n'), genreLore);
  const budget = buildContextBudget({ caps: provider.caps, maxTokens, scale: opts.scale, reserved: opts.reserved });
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
  return userText;
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
