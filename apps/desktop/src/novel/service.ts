/**
 * Studio service: the interactive planning steps (outline → chapter table) and job creation.
 * Planning runs in the foreground with streaming; chapter writing runs as background jobs.
 */
import { nanoid } from 'nanoid';
import { emptyBible, emptyDerivative, splitChapters, type DerivativeDecl, type StorylineDoc, type StyleProfile } from '@the-water/shared';
import { createNovel, getNovel, updateNovel, type Novel } from '@/db/repos/novelsRepo';
import { buildStorylineDoc, createSnapshot, getStyleExtras, replaceStorylineRows, setDerivative, setStyleProfile } from '@/db/repos/storylineRepo';
import { createVersion, deleteChaptersFrom, listChapters, markStaleFrom, upsertChapterPlan, type Chapter } from '@/db/repos/chaptersRepo';
import { saveBible } from '@/db/repos/bibleRepo';
import { createJob, listJobs } from '@/db/repos/jobsRepo';
import { providerForPurpose } from '@/llm/registry';
import { requestJson } from '@/llm/json';
import { outlinePrompt } from '@/llm/prompts/outline';
import { chapterTableBatches, chapterTablePrompt } from '@/llm/prompts/chapterTable';
import { matchBeatByTitle, toStorylineDoc, type ChapterTable, type OutlineDoc, type NovelRequirements } from '@/novel/types';
import { normalizeTargets, planChapterCount } from '@/novel/wordBudget';
import { planGenerate, planRegenerate, planRewrite, planStyleCheck, type RewriteItemInput } from '@/jobs/planner';
import { profileFromFreeText } from '@/novel/stylePresets';
import { isEmptyGenre, mergedGenreOf } from '@/novel/genrePacks';
import { kick } from '@/jobs/runner';
import { emitJobEvent } from '@/jobs/events';

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

/** Convert current storyline rows back to the name-based OutlineDoc shape (for the chapter-table prompt). */
export function storylineToOutline(doc: StorylineDoc, novel: Novel): OutlineDoc {
  const nameOf = (id: string) => doc.characters.find((c) => c.id === id)?.name ?? id;
  const setNameOf = (id: string) => doc.settings.find((s) => s.id === id)?.name ?? id;
  return {
    title: novel.title,
    logline: novel.meta.logline,
    themes: doc.themes,
    settings: doc.settings.map((s) => ({ name: s.name, kind: s.kind, description: s.description })),
    characters: doc.characters.map((c) => ({ name: c.name, aliases: c.aliases, role: c.role, description: c.description, arc: c.arc, relationships: c.relationships.map((r) => ({ targetName: nameOf(r.targetId), kind: r.kind, note: r.note })) })),
    arcs: doc.arcs.map((a) => ({ title: a.title, summary: a.summary, startChapterNo: a.startChapterNo, endChapterNo: a.endChapterNo })),
    beats: doc.beats.map((b) => ({ arcIndex: Math.max(0, doc.arcs.findIndex((a) => a.id === b.arcId)), title: b.title, summary: b.summary, characterNames: b.characterIds.map(nameOf), settingNames: b.settingIds.map(setNameOf), suggestedChapterNo: b.chapterNo })),
  };
}

/** Step 1: outline → storyline rows (characters/settings/arcs/beats), novel title/logline/themes. */
export async function generateOutline(novelId: string, onDelta?: (text: string) => void, signal?: AbortSignal): Promise<OutlineDoc> {
  const novel = await getNovel(novelId);
  if (!novel) throw new Error('小说不存在');
  const { provider } = await providerForPurpose('planning');
  const chapterCount = planChapterCount(novel.targetChars);
  const spec = outlinePrompt({ premise: novel.premise, requirements: novel.requirements, targetChars: novel.targetChars, chapterCount });
  const r = await requestJson(provider, { ...spec, schema: spec.schema! }, { signal, onDelta: (_d, acc) => onDelta?.(acc) });
  const outline = r.value;
  const doc = toStorylineDoc(outline, novel.premise, [], () => nanoid());
  await replaceStorylineRows(novelId, doc);
  await updateNovel(novelId, {
    title: novel.title && novel.title !== '未命名小说' ? novel.title : outline.title || novel.title,
    status: 'planning',
    meta: { ...novel.meta, logline: outline.logline, themes: outline.themes, outlineDone: true, tableDone: false },
  });
  emitJobEvent({ type: 'novel:storylineUpdated', novelId });
  return outline;
}

/** Step 2: chapter table (batched) → chapter rows; resolves beat titles / POV names against current rows. */
export async function generateChapterTable(novelId: string, onProgress?: (msg: string, partial: string) => void, signal?: AbortSignal): Promise<Chapter[]> {
  const novel = await getNovel(novelId);
  if (!novel) throw new Error('小说不存在');
  const { provider } = await providerForPurpose('planning');
  const doc = await buildStorylineDoc(novelId, novel.premise, novel.meta.themes);
  const outline = storylineToOutline(doc, novel);
  const total = planChapterCount(novel.targetChars);
  const perChapter = Math.round(novel.targetChars / total);
  const table: ChapterTable = [];
  for (const [from, to] of chapterTableBatches(total)) {
    const count = to - from + 1;
    onProgress?.(`正在规划第 ${from}–${to} 章（共 ${total} 章）`, '');
    const spec = chapterTablePrompt({ outline, requirements: novel.requirements, fromChapter: from, toChapter: to, totalChapters: total, batchTotalChars: perChapter * count, minChars: Math.max(800, Math.round(perChapter * 0.6)), maxChars: Math.round(perChapter * 1.5), previousEntries: table.slice(-3) });
    const r = await requestJson(provider, { ...spec, schema: spec.schema! }, { signal, onDelta: (_d, acc) => onProgress?.(`正在规划第 ${from}–${to} 章`, acc) });
    const entries = r.value.filter((e) => e.chapterNo >= from && e.chapterNo <= to).sort((a, b) => a.chapterNo - b.chapterNo);
    // fill gaps defensively
    for (let n = from; n <= to; n++) if (!entries.some((e) => e.chapterNo === n)) entries.push({ chapterNo: n, title: `第${n}章`, goal: '', beatTitles: [], povCharacter: null, targetChars: perChapter, endHook: '' });
    table.push(...entries.sort((a, b) => a.chapterNo - b.chapterNo));
  }
  const targets = normalizeTargets(table.map((e) => e.targetChars || perChapter), novel.targetChars);
  await deleteChaptersFrom(novelId, 1);
  const chapters: Chapter[] = [];
  for (let i = 0; i < table.length; i++) {
    const e = table[i]!;
    const beatIds = e.beatTitles.map((t) => matchBeatByTitle(t, doc.beats)?.id).filter((x): x is string => !!x);
    const pov = e.povCharacter ? doc.characters.find((c) => c.name === e.povCharacter || c.aliases.includes(e.povCharacter!))?.id ?? null : null;
    chapters.push(await upsertChapterPlan(novelId, { chapterNo: e.chapterNo, title: e.title, goal: e.goal, targetChars: targets[i]!, povCharacterId: pov, beatIds, endHook: e.endHook }));
  }
  // beats without chapterNo → take it from the first chapter that lists them
  for (const b of doc.beats) {
    if (b.chapterNo != null) continue;
    const ch = chapters.find((c) => c.beatIds.includes(b.id));
    if (ch) { const { upsertBeat } = await import('@/db/repos/storylineRepo'); await upsertBeat(novelId, { ...b, chapterNo: ch.chapterNo }); }
  }
  const finalDoc = await buildStorylineDoc(novelId, novel.premise, novel.meta.themes);
  await createSnapshot(novelId, finalDoc, 'generated');
  await saveBible(novelId, 0, initialBible(finalDoc));
  await updateNovel(novelId, { meta: { ...novel.meta, tableDone: true } });
  emitJobEvent({ type: 'novel:storylineUpdated', novelId });
  return chapters;
}

function initialBible(doc: StorylineDoc) {
  const b = emptyBible();
  for (const c of doc.characters) b.characters[c.id] = { name: c.name, state: c.description.slice(0, 300), location: '', knowledge: '', relationships: c.relationships.map((r) => `${doc.characters.find((x) => x.id === r.targetId)?.name ?? ''}：${r.kind}${r.note ? '，' + r.note : ''}`) };
  b.facts = doc.settings.map((s) => `${s.name}：${s.description}`.slice(0, 300));
  return b;
}

async function ensureNoActiveJob(novelId: string): Promise<void> {
  const active = await listJobs({ novelId, statuses: ['queued', 'running', 'pausing', 'paused'] });
  if (active.length) throw new Error('该小说已有进行中的任务，请先完成或取消');
}

/** Start writing all unwritten chapters (or a subset). */
export async function startGeneration(novelId: string, opts: { only?: number[]; force?: boolean } = {}): Promise<string> {
  await ensureNoActiveJob(novelId);
  const chapters = await listChapters(novelId);
  const steps = planGenerate(chapters, { force: opts.force, only: opts.only ? new Set(opts.only) : undefined, styleCheck: await wantsStyleCheck(novelId) });
  if (steps.length === 0) throw new Error('没有需要生成的章节');
  const job = await createJob({ novelId, type: 'generate_novel', params: { only: opts.only ?? null }, providerId: null, steps });
  await updateNovel(novelId, { status: 'generating' });
  kick();
  return job.id;
}

export async function regenerateChapter(novelId: string, chapterNo: number, opts: { cascade?: boolean } = {}): Promise<string> {
  await ensureNoActiveJob(novelId);
  const chapters = await listChapters(novelId);
  const target = chapters.find((c) => c.chapterNo === chapterNo);
  if (!target) throw new Error('章节不存在');
  const following = opts.cascade ? chapters.filter((c) => c.chapterNo > chapterNo && c.currentVersionId) : [];
  if (!opts.cascade) await markStaleFrom(novelId, chapterNo + 1, '上游章节已重新生成');
  const job = await createJob({ novelId, type: 'regenerate_chapter', params: { chapterNo, cascade: !!opts.cascade }, providerId: null, steps: planRegenerate(target, following, { styleCheck: await wantsStyleCheck(novelId) }) });
  kick();
  return job.id;
}

export async function startRewrite(novelId: string, items: RewriteItemInput[], snapshotBeforeId: string | null): Promise<string> {
  await ensureNoActiveJob(novelId);
  const novel = await getNovel(novelId);
  if (!novel) throw new Error('小说不存在');
  const steps = planRewrite(items, { styleCheck: await wantsStyleCheck(novelId) });
  if (steps.length === 0) throw new Error('没有选中任何章节');
  // snapshot the NEW storyline so rewritten versions reference it
  const doc = await buildStorylineDoc(novelId, novel.premise, novel.meta.themes);
  await createSnapshot(novelId, doc, 'user_commit');
  const job = await createJob({ novelId, type: 'rewrite', params: { snapshotBeforeId, chapterNos: items.map((i) => i.chapter.chapterNo) }, providerId: null, steps });
  kick();
  return job.id;
}

/** 拆书：从现有正文提取文风档案 + 人物言行规格 + 规矩（后台任务）。 */
export async function startStyleExtraction(novelId: string): Promise<string> {
  await ensureNoActiveJob(novelId);
  const job = await createJob({ novelId, type: 'extract_style', params: {}, providerId: null, steps: [{ kind: 'extract_style', chapterId: null, input: {} }] });
  kick();
  return job.id;
}

/** 单章审校（不改写流程，只出报告并在不达标时定点修订一次）。 */
export async function startStyleCheck(novelId: string, chapterNo: number): Promise<string> {
  await ensureNoActiveJob(novelId);
  const chapter = (await listChapters(novelId)).find((c) => c.chapterNo === chapterNo);
  if (!chapter) throw new Error('章节不存在');
  if (!chapter.currentVersionId) throw new Error('这一章还没有正文');
  const job = await createJob({ novelId, type: 'style_check', params: { chapterNo }, providerId: null, steps: planStyleCheck(chapter) });
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
