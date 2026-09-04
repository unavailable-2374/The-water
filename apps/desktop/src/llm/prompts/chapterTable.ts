import type { PromptSpec } from '@/llm/types';
import { ChapterTableSchema, type ChapterTable, type NovelRequirements, type OutlineDoc } from '@/novel/types';
import { joinSections, planningSystem, section, sys, takeLast, user } from './base';

export const CHAPTER_TABLE_BATCH_SIZE = 30;

export interface ChapterTableInput {
  outline: OutlineDoc;
  requirements: NovelRequirements;
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

export const CHAPTER_TABLE_JSON_SHAPE = `[
  { "chapterNo": 1, "title": "章节标题", "goal": "本章要达成的叙事目标", "beatTitles": ["情节点标题"], "povCharacter": "视角人物姓名或 null", "targetChars": 3000, "endHook": "章末悬念或转折" }
]`;

function renderOutline(o: OutlineDoc, from: number, to: number): string {
  const lines: string[] = [];
  if (o.title) lines.push(`书名：${o.title}`);
  if (o.logline) lines.push(`主线：${o.logline}`);
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

export function chapterTablePrompt(input: ChapterTableInput): PromptSpec<ChapterTable> {
  const from = input.fromChapter;
  const to = input.toChapter;
  const count = to - from + 1;
  const system = planningSystem('你是一位资深小说策划编辑，负责把大纲拆解成逐章的章节表。', input.requirements);

  const constraints = [
    '硬性约束：',
    `1. 恰好输出第 ${from} 章到第 ${to} 章，共 ${count} 条；chapterNo 连续递增，不得缺漏或重复。全书共 ${input.totalChapters} 章。`,
    `2. 本批所有 targetChars 之和必须等于 ${input.batchTotalChars}；单章 targetChars 在 ${input.minChars}–${input.maxChars} 之间。`,
    '3. beatTitles 只能使用上面列出的情节点标题（逐字一致），每章 1–3 个，同一情节点不要重复分配到多章。',
    '4. povCharacter 只能是上面列出的人物姓名，或 null。',
    '5. 每章的 goal 要具体（本章推进了什么），endHook 要给出章末悬念或转折。',
    '6. 章节标题不带"第X章"前缀，简体中文。',
  ].join('\n');

  const prev = takeLast(input.previousEntries, 3);
  const text = joinSections([
    section('大纲', renderOutline(input.outline, from, to)),
    prev.length ? section('上一批末尾章节（保持衔接）', renderPrevious(prev)) : '',
    section('任务', `请为第 ${from}–${to} 章生成章节表，严格按下面的 JSON 数组结构输出。\n${constraints}`),
    section('JSON 结构', CHAPTER_TABLE_JSON_SHAPE),
  ]);

  return {
    messages: [sys(system), user(text)],
    maxTokens: 8000,
    temperature: 0.5,
    schema: ChapterTableSchema,
    label: '生成章节表',
  };
}
