import { PlannedThreadSchema } from '@/novel/threadPlanning';
import { z } from 'zod';
import { genreOutlineBlock } from './outline';
import { mergedGenreOf } from '@/novel/genrePacks';
import type { WritingCardData } from '@the-water/shared';
import { docTypeGuide } from '@/novel/docTypes';
import { PLOT_PLANNING_RULE } from '@/novel/plotDesign';
import type { PromptSpec } from '@/llm/types';
import { ChapterTableSchema, type ChapterTable, type NovelRequirements, type OutlineDoc } from '@/novel/types';
import { joinSections, planningSystem, section, sys, takeLast, user } from './base';

export const CHAPTER_TABLE_BATCH_SIZE = 30;

export interface ChapterTableInput {
  outline: OutlineDoc;
  /** Confirmed workbench materials survive reconstruction of legacy storyline rows. */
  writingCards?: readonly WritingCardData[];
  requirements: NovelRequirements;
  planThreads?: boolean;
  /** Supplemental plans must not retroactively invent setups in preserved chapters. */
  preserveBeforeChapter?: number;
  fromChapter: number;
  toChapter: number;
  totalChapters: number;
  batchTotalChars: number;
  minChars: number;
  maxChars: number;
  /** Entries from the previous batch (the last 3 are used) for continuity. */
  previousEntries: ChapterTable;
}

/** Split 1..totalChapters into inclusive [from, to] batches. */
export function chapterTableBatches(totalChapters: number, batchSize: number = CHAPTER_TABLE_BATCH_SIZE): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const size = Math.max(1, Math.floor(batchSize));
  for (let from = 1; from <= totalChapters; from += size) {
    out.push([from, Math.min(totalChapters, from + size - 1)]);
  }
  return out;
}

/** Missing ranges only; preserve sparse confirmed chapters and cached successful batches. */
export function pendingChapterBatches(total: number, known: ReadonlySet<number>, size = CHAPTER_TABLE_BATCH_SIZE): Array<[number,number]> {
  const ranges: Array<[number,number]> = [];
  let start: number | null = null;
  for (let n=1; n<=total+1; n++) {
    if (n<=total && !known.has(n)) {
      start ??= n;
      if (n-start+1>=size) { ranges.push([start,n]); start=null; }
    } else if (start!==null) { ranges.push([start,n-1]); start=null; }
  }
  return ranges;
}

export const ChapterTableResponseSchema = z.object({ chapters: ChapterTableSchema, threads: z.array(PlannedThreadSchema).max(30).optional() });

export const CHAPTER_TABLE_JSON_SHAPE = `{ "chapters": [
  { "chapterNo": 1, "title": "章节标题", "goal": "本章要达成的叙事目标", "beatTitles": ["情节点标题"], "povCharacter": "视角人物姓名或 null", "targetChars": 3000, "endHook": "章末悬念、决定、关系变化或余味" }
] }`;

function renderOutline(o: OutlineDoc, from: number, to: number): string {
  const lines: string[] = [];
  if (o.title) lines.push(`书名：${o.title}`);
  if (o.logline) lines.push(`主线：${o.logline}`);
  if (o.writing) lines.push(`创作说明与分卷计划：${JSON.stringify(o.writing)}`);
  if (o.themes.length) lines.push(`主题：${o.themes.join('、')}`);
  if (o.characters.length) {
    lines.push('人物：');
    for (const c of o.characters) lines.push(`- ${c.name}${c.role ? `（${c.role}）` : ''}${c.description ? `：${c.description}` : ''}`);
  }
  if (o.settings.length) {
    lines.push('设定：');
    for (const s of o.settings) lines.push(`- ${s.name}${s.description ? `：${s.description}` : ''}`);
  }
  if (o.arcs.length) {
    lines.push('故事弧：');
    o.arcs.forEach((a, i) => lines.push(`- [${i}] ${a.title}（第${a.startChapterNo}–${a.endChapterNo}章）${a.summary ? `：${a.summary}` : ''}`));
  }
  const beats = o.beats.filter((b) => b.suggestedChapterNo === null || (b.suggestedChapterNo >= from && b.suggestedChapterNo <= to));
  if (beats.length) {
    lines.push('情节点（可用的 beatTitles）：');
    for (const b of beats) {
      const where = b.suggestedChapterNo !== null ? `建议第${b.suggestedChapterNo}章` : '章节待定';
      lines.push(`- ${b.title}（弧[${b.arcIndex}]，${where}）${b.summary ? `：${b.summary}` : ''}`);
    }
  }
  return lines.join('\n');
}

function renderPrevious(entries: ChapterTable): string {
  return entries
    .map((e) => `第${e.chapterNo}章 ${e.title}｜目标：${e.goal}｜视角：${e.povCharacter ?? '无'}｜${e.targetChars} 字｜结尾：${e.endHook}`)
    .join('\n');
}

export function chapterTablePrompt(input: ChapterTableInput): PromptSpec<z.infer<typeof ChapterTableResponseSchema>> {
  const from = input.fromChapter;
  const to = input.toChapter;
  const count = to - from + 1;
  const latePayoff = to < input.totalChapters ? to+1 : Math.min(input.totalChapters,from+2);
  const system = [planningSystem('你是一位资深小说策划编辑，负责把大纲拆解成逐章的章节表。', input.requirements), docTypeGuide(input.requirements.docType).fiction ? PLOT_PLANNING_RULE : ''].filter(Boolean).join('\n');

  const constraints = [
    '硬性约束：',
    `1. 恰好输出第 ${from} 章到第 ${to} 章，共 ${count} 条；chapterNo 连续递增，不得缺漏或重复。全书共 ${input.totalChapters} 章。`,
    `2. 本批篇幅参考约 ${input.batchTotalChars} 字，不要求字数总和相等。targetChars 依本章选择、冲突、关系互动和结尾收束估算，大章可显著超过参考，小章应有完整事件，通常至少约 ${Math.min(1000,input.minChars)} 字，避免拆成零碎残章。不要平均分配、压缩大章或灌水小章来凑总量。`,
    '3. beatTitles 只能使用上面列出的情节点标题（逐字一致），有已细化情节点时每章 1–3 个；远期章节可填 []，按故事弧规划独立职责，不得为了填满而复用前五章情节点。',
    '4. povCharacter 只能是上面列出的人物姓名，或 null。',
    '5. 每章的 goal 要具体（本章推进了什么），endHook 要给出章末悬念、决定、关系变化或余味。',
    '远期章节也必须有具体标题、目标和结尾方向；全书高层章节表与只细化未来五章的场景计划是两个尺度。跨批次按同一份伏笔时间表埋设、推进和回收，不提前泄露最终答案。',
    '遵守已确认故事弧的因果顺序与叙事职责，不把后期核心反转、人物反水、完整证据闭合及最终清算提前兑现。章号与篇幅是可修改的规划位置；若剧情需要增减章节，作为后续结构修改候选供作者审阅，不在当前分批任务中偷偷改变已确认顺序。',
    ...(input.planThreads ? ['同时返回 threads 数组，提出 2–6 条跨章伏笔；至少一条回收在第六章或更晚。每条包含 title/setup/progression/payoff/plannedChapterNo/characterNames/milestones。milestones 是按章递增的 [{chapterNo,kind:setup|progress|payoff,detail}]：埋设、至少一次推进、最后回收，须覆盖不同章节且不超全书范围。说明读者能看到什么、暂不能知道什么以及回收怎样改变理解或选择；不把未来计划当正文事实。plannedChapterNo 等于 payoff 阶段章号。characterNames 必须来自已有人物。'] : []),
    ...(input.planThreads ? [`threads 是当前全书方案的伏笔时间表，不限于本批 ${from}–${to} 章。安排贯穿中后期故事弧的伏笔；全书尚有后续批次时，至少一条 plannedChapterNo >= ${latePayoff}，避免把长线伏笔全部压在首批回收。具体章号可随作者调整结构移动，不按固定章数制造反转。`] : []),
    ...(input.preserveBeforeChapter ? [`第 ${input.preserveBeforeChapter} 章之前的计划和正文保持原状；新增伏笔的埋设不得早于第 ${input.preserveBeforeChapter} 章，不得声称此前正文已经埋下新线索。`] : []),
    '6. 章节标题不带"第X章"前缀，简体中文。',
  ].join('\n');

  const prev = takeLast(input.previousEntries, 3);
  const text = joinSections([
    section('大纲', renderOutline(input.outline, from, to)),
    input.writingCards?.length ? section('已确认创作资料（规划约束，非既成事实）', JSON.stringify(input.writingCards)) : '',
    section('结构与阅读体验', docTypeGuide(input.requirements.docType).outlineRules.join('\n')),
    docTypeGuide(input.requirements.docType).fiction ? genreOutlineBlock(mergedGenreOf(input.requirements)) : '',
    prev.length ? section('上一批末尾章节（保持衔接）', renderPrevious(prev)) : '',
    section('任务', `请为第 ${from}–${to} 章生成章节表，严格按下面的 JSON 对象结构输出，根对象的 chapters 字段承载章节数组。\n${constraints}`),
    section('JSON 结构', CHAPTER_TABLE_JSON_SHAPE),
  ]);

  return {
    messages: [sys(system), user(text)],
    maxTokens: 12000,
    temperature: 0.5,
    schema: ChapterTableResponseSchema.superRefine((value,ctx) => {
      if (value.chapters.length !== count || new Set(value.chapters.map(c=>c.chapterNo)).size !== count) ctx.addIssue({code:'custom',path:['chapters'],message:'必须完整返回本批章节，不得遗漏或重复'});
      for (const [i,c] of value.chapters.entries()) if (c.chapterNo<from || c.chapterNo>to || !c.title.trim() || !c.goal.trim() || !c.endHook.trim() || c.targetChars<=0) ctx.addIssue({code:'custom',path:['chapters',i],message:'章号必须在本批范围内，标题、目标、结尾方向和篇幅参考不得留空'});
      if (input.planThreads && (!value.threads?.length || !value.threads.some(t=>t.plannedChapterNo>5))) ctx.addIssue({code:'custom',path:['threads'],message:'长篇必须给出跨越前五章的伏笔计划'});
      if (input.planThreads && !value.threads?.some(t=>t.plannedChapterNo>=latePayoff)) ctx.addIssue({code:'custom',path:['threads'],message:`全书伏笔至少一条须回收在第 ${latePayoff} 章或更晚，不能压缩在当前批次`});
      for (const [i,t] of (value.threads ?? []).entries()) {
        if (input.preserveBeforeChapter && t.milestones.some(m=>m.chapterNo<input.preserveBeforeChapter!)) ctx.addIssue({code:'custom',path:['threads',i],message:'补充伏笔不得追写保留章节中的埋设'});
        if (t.milestones.some(m=>m.chapterNo>input.totalChapters) || !t.milestones.some(m=>m.kind==='progress')) ctx.addIssue({code:'custom',path:['threads',i],message:'阶段不得超全书范围，且必须安排跨章推进'});
        if (t.characterNames.some(name=>!input.outline.characters.some(c=>c.name===name || c.aliases.includes(name)))) ctx.addIssue({code:'custom',path:['threads',i,'characterNames'],message:'伏笔人物必须来自大纲'});
      }
    }),
    label: '生成章节表',
  };
}
