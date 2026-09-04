/**
 * 规划阶段（大纲 / 章节表）的落库逻辑。
 *
 * 这些代码原本长在 `novel/service.ts` 的前台函数里（§2.1 第 1 条：不持久化、
 * 不可恢复、崩溃即全丢）。搬到这里之后，`jobs/steps/outlineStep.ts` 与
 * `chapterTableStep.ts` 只负责调模型，写库统一走这里；service 层则只剩下建任务。
 */
import { nanoid } from 'nanoid';
import { emptyBible, type StorylineDoc } from '@the-water/shared';
import { getNovel, updateNovel, type Novel } from '@/db/repos/novelsRepo';
import { buildStorylineDoc, createSnapshot, replaceStorylineRows, upsertBeat } from '@/db/repos/storylineRepo';
import { deleteChaptersFrom, listChapters, upsertChapterPlan, type Chapter } from '@/db/repos/chaptersRepo';
import { saveBible } from '@/db/repos/bibleRepo';
import { matchBeatByTitle, toStorylineDoc, type ChapterTable, type ChapterTableEntry, type OutlineDoc } from '@/novel/types';
import { normalizeTargets } from '@/novel/wordBudget';
import { emitJobEvent } from '@/jobs/events';

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

export function initialBible(doc: StorylineDoc) {
  const b = emptyBible();
  for (const c of doc.characters) b.characters[c.id] = { name: c.name, state: c.description.slice(0, 300), location: '', knowledge: '', relationships: c.relationships.map((r) => `${doc.characters.find((x) => x.id === r.targetId)?.name ?? ''}：${r.kind}${r.note ? '，' + r.note : ''}`) };
  b.facts = doc.settings.map((s) => `${s.name}：${s.description}`.slice(0, 300));
  return b;
}

/** 把一批章节表条目补齐、排序、裁到 [from, to] 区间内。纯函数。 */
export function normalizeBatchEntries(entries: readonly ChapterTableEntry[], from: number, to: number, perChapter: number): ChapterTableEntry[] {
  const kept = entries.filter((e) => e.chapterNo >= from && e.chapterNo <= to);
  const byNo = new Map<number, ChapterTableEntry>();
  for (const e of kept) if (!byNo.has(e.chapterNo)) byNo.set(e.chapterNo, e);
  const out: ChapterTableEntry[] = [];
  for (let n = from; n <= to; n++) {
    out.push(byNo.get(n) ?? { chapterNo: n, title: `第${n}章`, goal: '', beatTitles: [], povCharacter: null, targetChars: perChapter, endHook: '' });
  }
  return out;
}

/** 大纲落库：故事线行 + 书名 / 主线 / 主题。 */
export async function applyOutline(novelId: string, outline: OutlineDoc): Promise<void> {
  const novel = await getNovel(novelId);
  if (!novel) throw new Error('小说不存在');
  const doc = toStorylineDoc(outline, novel.premise, [], () => nanoid());
  await replaceStorylineRows(novelId, doc);
  await updateNovel(novelId, {
    title: novel.title && novel.title !== '未命名小说' ? novel.title : outline.title || novel.title,
    status: 'planning',
    meta: { ...novel.meta, logline: outline.logline, themes: outline.themes, outlineDone: true, tableDone: false },
  });
  emitJobEvent({ type: 'novel:storylineUpdated', novelId });
}

/**
 * 章节表落库。会先删掉已有章节再重建，所以在删之前**自动落一份故事线快照**
 * （reason = pre_rewrite，语义就是「破坏性重建之前的存档」），
 * 用户误重排时还能从「故事线 → 版本」里找回来。
 */
export async function applyChapterTable(novelId: string, table: ChapterTable): Promise<Chapter[]> {
  const novel = await getNovel(novelId);
  if (!novel) throw new Error('小说不存在');
  const doc = await buildStorylineDoc(novelId, novel.premise, novel.meta.themes);
  const perChapter = table.length ? Math.round(novel.targetChars / table.length) : 0;
  const targets = normalizeTargets(table.map((e) => e.targetChars || perChapter), novel.targetChars);

  const existing = await listChapters(novelId);
  if (existing.length > 0) await createSnapshot(novelId, doc, 'pre_rewrite');
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
    if (ch) await upsertBeat(novelId, { ...b, chapterNo: ch.chapterNo });
  }
  const finalDoc = await buildStorylineDoc(novelId, novel.premise, novel.meta.themes);
  await createSnapshot(novelId, finalDoc, 'generated');
  await saveBible(novelId, 0, initialBible(finalDoc));
  await updateNovel(novelId, { meta: { ...novel.meta, tableDone: true } });
  emitJobEvent({ type: 'novel:storylineUpdated', novelId });
  return chapters;
}
