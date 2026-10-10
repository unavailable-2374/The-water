import { docTypeGuide } from './docTypes';
import type { AtomicWriter } from '@/db/db';
import { plannedThreadCards, type PlannedThread } from './threadPlanning';
import { listWritingCards } from '@/db/repos/writingRepo';
import type { WritingCardData } from '@the-water/shared';
/**
 * 规划阶段（大纲 / 章节表）的落库逻辑。
 *
 * 这些代码原本长在 `novel/service.ts` 的前台函数里（§2.1 第 1 条：不持久化、
 * 不可恢复、崩溃即全丢）。搬到这里之后，`jobs/steps/outlineStep.ts` 与
 * `chapterTableStep.ts` 只负责调模型，写库统一走这里；service 层则只剩下建任务。
 */
import { nanoid } from 'nanoid';
import { emptyBible, type StorylineDoc } from '@the-water/shared';
import { getNovel, type Novel } from '@/db/repos/novelsRepo';
import { buildStorylineDoc } from '@/db/repos/storylineRepo';
import { matchBeatByTitle, toStorylineDoc, type ChapterTable, type ChapterTableEntry, type OutlineDoc, OutlineDocSchema } from '@/novel/types';
import { proposeDocumentPlan } from '@/db/repos/planProposalsRepo';
import { chapterCountForStory } from '@/novel/wordBudget';

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

/** Planned descriptions are not witnessed facts. */
export function initialBible(_doc: StorylineDoc) { return emptyBible(); }

/** 把一批章节表条目补齐、排序、裁到 [from, to] 区间内。纯函数。 */
export function normalizeBatchEntries(entries: readonly ChapterTableEntry[], from: number, to: number, perChapter: number): ChapterTableEntry[] {
  const kept = entries.filter((e) => e.chapterNo >= from && e.chapterNo <= to);
  const byNo = new Map<number, ChapterTableEntry>();
  for (const e of kept) if (!byNo.has(e.chapterNo)) byNo.set(e.chapterNo, e);
  const out: ChapterTableEntry[] = [];
  for (let n = from; n <= to; n++) {
    const entry=byNo.get(n);
    if(!entry) throw new Error(`章节规划缺少第 ${n} 章，不能填充未经生成的内容`);
    out.push({...entry,targetChars:entry.targetChars || perChapter});
  }
  return out;
}

/** 大纲落库：故事线行 + 书名 / 主线 / 主题。 */
export async function applyOutline(novelId: string, outline: OutlineDoc, commit?: AtomicWriter, reviewRequired = true): Promise<string> {
  outline = OutlineDocSchema.parse(outline);
  const novel = await getNovel(novelId);
  if (!novel) throw new Error('小说不存在');
  const before = await buildStorylineDoc(novelId,novel.premise,novel.meta.themes);
  const proposed = toStorylineDoc(outline, novel.premise, [], () => nanoid());
  const ids = new Map<string,string>();
  for (const key of ['characters','settings','arcs','beats'] as const) for (const e of proposed[key]) {
    const name = 'name' in e ? e.name : e.title;
    const old = before[key].find(c => ('name' in c ? c.name:c.title)===name);
    ids.set(e.id,old?.id ?? e.id);
  }
  const ref = (id:string) => ids.get(id) ?? id;
  proposed.characters = proposed.characters.map(c=>({...before.characters.find(old=>old.id===ref(c.id)),...c,id:ref(c.id),relationships:c.relationships.map(r=>({...r,targetId:ref(r.targetId)}))}));
  // Preserve voice/redlines already confirmed by the author.
  for (const c of proposed.characters) { const old = before.characters.find(o=>o.id===c.id); if (old) Object.assign(c,{speechSamples:old.speechSamples,verbalTics:old.verbalTics,addressBook:old.addressBook,redlines:old.redlines}); }
  proposed.settings = proposed.settings.map(c=>({...c,id:ref(c.id)}));
  proposed.arcs = proposed.arcs.map(c=>({...c,id:ref(c.id)}));
  proposed.beats = proposed.beats.map(c=>({...c,id:ref(c.id),arcId:c.arcId ? ref(c.arcId):null,characterIds:c.characterIds.map(ref),settingIds:c.settingIds.map(ref)}));
  const merge = <T extends {id:string}>(old:T[], next:T[]):T[] => [...old.filter(c=>!next.some(n=>n.id===c.id)),...next];
  // Before chapter planning, reconstruction replaces the whole draft. Once chapters
  // reference the plan, retain existing entities for explicit downstream rewrite review.
  const replaceDraft = before.chapters.length === 0;
  const after:StorylineDoc = {...before,themes:proposed.themes,characters:replaceDraft ? proposed.characters : merge(before.characters,proposed.characters),settings:replaceDraft ? proposed.settings : merge(before.settings,proposed.settings),arcs:replaceDraft ? proposed.arcs : merge(before.arcs,proposed.arcs),beats:replaceDraft ? proposed.beats : merge(before.beats,proposed.beats)};
  const existingCards=await listWritingCards(novelId), generated:WritingCardData[]=[];
  if(outline.writing) {
    generated.push({kind:'brief',data:outline.writing.brief});
    for(const volume of outline.writing.volumes) {
      if(volume.arcIndexes.some(i=>!proposed.arcs[i])) throw new Error('分卷引用不存在的故事弧');
      generated.push({kind:'volume',data:{title:volume.title,summary:volume.summary,startChapterNo:volume.startChapterNo,endChapterNo:volume.endChapterNo,arcIds:volume.arcIndexes.map(i=>proposed.arcs[i]!.id)}});
    }
    for(const intent of outline.writing.intents) {
      const character=proposed.characters.find(c=>c.name===intent.characterName || c.aliases.includes(intent.characterName));
      if(!character) throw new Error('人物动机引用不存在的人物');
      const {characterName: _name, ...intentData} = intent;
      generated.push({kind:'character',data:{...intentData,characterId:character.id}});
    }
  }
  if (outline.writing?.threads) generated.push(...plannedThreadCards(outline.writing.threads, proposed.characters));
  const cards=generated.map(card=>{const old=existingCards.find(c=>c.kind===card.kind && (card.kind==='brief' || card.kind==='volume' && c.kind==='volume' && c.data.title===card.data.title || card.kind==='character' && c.kind==='character' && c.data.characterId===card.data.characterId || card.kind==='thread' && c.kind==='thread' && c.data.title===card.data.title));return {id:old?.id ?? nanoid(),revision:old?.revision ?? 0,before:old ?? null,after:card};});
  const retiredCards = replaceDraft ? existingCards.filter(c => c.confirmed && ['brief','volume','character'].includes(c.kind) && !cards.some(next => next.id === c.id)).map(c=>({id:c.id,revision:c.revision,before:c})) : [];
  return proposeDocumentPlan(novelId,after,'大纲 / Outline',{logline:outline.logline,outlineDone:true,...(reviewRequired && docTypeGuide(novel.requirements.docType).fiction ? {outlineReviewRequired:true} : {})},outline.title,cards,retiredCards,commit);
}

/** AI chapter plans remain proposals; adopting them preserves prose/history. */
export async function applyChapterTable(novelId: string, table: ChapterTable, threads: readonly PlannedThread[] = [], opts: { preserveExisting?: boolean; commit?: AtomicWriter } = {}): Promise<string> {
  const novel = await getNovel(novelId);
  if (!novel) throw new Error('小说不存在');
  const doc = await buildStorylineDoc(novelId, novel.premise, novel.meta.themes);
  const total = Math.max(chapterCountForStory(doc,novel.targetChars,novel.requirements.docType),...table.map(c=>c.chapterNo)), perChapter = Math.round(novel.targetChars/total);
  const plans = new Map(doc.chapters.filter(c=>c.chapterNo<=total || c.title.trim() || c.goal.trim()).map(c=>[c.chapterNo,c]));
  for (let i=0;i<table.length;i++) {
    const e = table[i]!;
    if (opts.preserveExisting && plans.get(e.chapterNo)?.title.trim() && plans.get(e.chapterNo)?.goal.trim()) continue;
    plans.set(e.chapterNo,{chapterNo:e.chapterNo,title:e.title,goal:e.goal,targetChars:e.targetChars || perChapter,povCharacterId:doc.characters.find(c=>c.name===e.povCharacter)?.id ?? null,beatIds:e.beatTitles.map(t=>matchBeatByTitle(t,doc.beats)?.id).filter((id):id is string=>!!id),endHook:e.endHook});
  }
  for (let n=1;n<=total;n++) if (!plans.get(n)?.title.trim() || !plans.get(n)?.goal.trim()) throw new Error(`全书章节计划缺少第 ${n} 章标题或目标，不能用空槽位冒充完整目录`);
  const cards = plannedThreadCards(threads, doc.characters).map(after => ({ id: nanoid(), revision: 0, before: null, after }));
  return proposeDocumentPlan(novelId,{...doc,chapters:[...plans.values()].sort((a,b)=>a.chapterNo-b.chapterNo)},'章节表 / Chapter plan',{tableDone:true,retireEmptyChapterSlots:true},undefined,cards,[],opts.commit);
}
