import type { PromptSpec } from '@/llm/types';
import type { StoryBible, StorylineDoc } from '@the-water/shared';
import { SummarizeResultSchema, type SummarizeResult } from '@/novel/types';
import { JSON_ONLY_RULE, joinSections, section, sys, user } from './base';
import { selectRelevantBible } from './context';

export interface SummarizeInput {
  chapterNo: number;
  chapterText: string;
  bibleBefore: StoryBible;
  doc: StorylineDoc;
}

export const SUMMARIZE_JSON_SHAPE = `{
  "summary": "本章摘要（≤300字）",
  "bibleDelta": {
    "characterUpdates": [{ "name": "人物姓名", "state": "当前状态/处境", "location": "所在位置", "knowledge": "新获得的信息", "relationshipChanges": ["与X的关系变化"] }],
    "newCharacters": [{ "name": "新登场人物", "role": "身份", "description": "简介" }],
    "newFacts": ["本章新确立的设定/事实"],
    "timelineEvents": [{ "event": "按发生顺序的关键事件" }],
    "openThreads": ["本章新埋下的悬念/伏笔"],
    "closedThreads": ["本章解决掉的既有线索（逐字引用）"],
    "arcSummary": null
  },
  "continuityWarnings": ["与故事圣经矛盾之处"]
}`;

export function summarizePrompt(input: SummarizeInput): PromptSpec<SummarizeResult> {
  const { chapterNo, doc } = input;
  const system = [
    '你是小说连载的责任编辑，负责维护故事圣经（人物状态、时间线、既定事实、未了线索），保证后续章节的连续性。',
    JSON_ONLY_RULE,
  ].join('\n');

  const knownNames = doc.characters.map((c) => (c.aliases.length ? `${c.name}（${c.aliases.join('、')}）` : c.name)).join('、');
  const { primary } = selectRelevantBible(input.bibleBefore, doc, chapterNo);
  const endingArc = doc.arcs.find((a) => a.endChapterNo === chapterNo);

  const rules = [
    '1. summary 不超过 300 字，按顺序概括本章事件、人物变化与揭示的信息，供后续章节参考。',
    '2. bibleDelta 只记录本章新增或发生变化的内容，不要重复已知的人物状态与事实；没有变化的字段留空字符串或空数组。',
    '3. characterUpdates / newCharacters 的 name 使用上面列出的正式姓名；本章首次出现且不在已知列表中的人物才放入 newCharacters。',
    '4. timelineEvents 给 3–8 条关键事件，每条一句话。',
    '5. closedThreads 只能从上面的"未了线索"中逐字选取；openThreads 只写本章新埋下的线索。',
    '6. continuityWarnings 指出本章正文与故事圣经相矛盾的地方（人物位置、已知信息、时间顺序等），没有则为空数组。',
    endingArc
      ? `7. 本章是故事弧《${endingArc.title}》的最后一章，请在 arcSummary 中用不超过 200 字总结该弧的完整走向。`
      : '7. 本章不是任何故事弧的最后一章，arcSummary 置为 null。',
  ].join('\n');

  const text = joinSections([
    section('已知人物', knownNames),
    section('故事圣经（相关部分）', primary),
    section(`第${chapterNo}章正文`, input.chapterText),
    section('任务', `请阅读第${chapterNo}章正文，输出摘要与故事圣经增量，严格按下面的 JSON 结构输出。\n${rules}`),
    section('JSON 结构', SUMMARIZE_JSON_SHAPE),
  ]);

  return {
    messages: [sys(system), user(text)],
    maxTokens: 3000,
    temperature: 0.3,
    schema: SummarizeResultSchema,
    label: `总结第${chapterNo}章`,
  };
}
