/**
 * 「查看当前提示词」（§2.3 第 6 条）：把 `llm/prompts/*` 的每个模板用一份示例输入
 * 真正渲染一遍，让用户看到发给模型的到底是什么。
 *
 * 关键点：**不复制一份提示词文案**，而是调用真正的模板函数。
 * 这样以后改模板，这里显示的内容自动跟着变，不会出现「界面上写的和实际发的不一样」。
 * 示例里的书名、人物、正文都是占位内容，真实运行时会换成这本书自己的数据。
 */
import { emptyBible, emptyDerivative, emptyStoryline, emptyStyleProfile, emptyVoice, type StoryBible, type StorylineDoc } from '@the-water/shared';
import type { ChatMessage, ProviderCaps } from '@/llm/types';
import { defaultRequirements, OutlineDocSchema, type NovelRequirements } from '@/novel/types';
import { chapterTablePrompt } from './chapterTable';
import { consistencyReviewPrompt } from './consistencyReview';
import { lengthAdjustPrompt } from './lengthAdjust';
import { outlinePrompt } from './outline';
import { passageDiscussPrompt } from './passageDiscuss';
import { rewriteChapterPrompt } from './rewriteChapter';
import { rewritePlanPrompt } from './rewritePlan';
import { styleExtractPrompt } from './styleExtract';
import { styleReviewPrompt } from './styleReview';
import { summarizePrompt } from './summarizeAndBible';
import { writeChapterPrompt } from './writeChapter';

export interface PromptPreview {
  id: string;
  /** 界面上显示的名字。 */
  label: string;
  /** 什么时候会用到它。 */
  when: string;
  /** 温度（写作类高、校对类低）。 */
  temperature: number;
  system: string;
  user: string;
}

const CAPS: ProviderCaps = { contextWindow: 128_000, maxOutputTokens: 8000, cjkTokenRatio: 0.7, jsonMode: 'json_object' };

const SAMPLE_REQUIREMENTS = (authorNote?: string): NovelRequirements => ({
  ...defaultRequirements(),
  genre: '（这本书的题材）',
  style: '（这本书的风格）',
  tone: '（基调）',
  audience: '（受众）',
  taboos: ['（禁止出现的内容）'],
  mustHave: ['（必须包含的元素）'],
  extra: authorNote ? '' : '（额外要求）',
});

const SAMPLE_TEXT = '（这里是章节正文。真实运行时是这本书当前这一章的全文。）';
const SAMPLE_CONTEXT = [
  '【本章计划】\n第3章 （章节标题）\n本章目标：（本章要完成什么）\n视角人物：（谁的视角）',
  '【故事圣经】\n主要相关人物：\n· （人物名）｜（身份）｜当前状态：（状态）',
].join('\n\n');

function sampleDoc(): StorylineDoc {
  return {
    ...emptyStoryline(),
    premise: '（故事前提）',
    characters: [{ id: 'c1', name: '（人物名）', aliases: ['（别名）'], role: '主角', description: '（简介）', arc: '', relationships: [], ...emptyVoice() }],
    arcs: [{ id: 'a1', title: '（故事弧）', summary: '（走向）', startChapterNo: 1, endChapterNo: 10 }],
    chapters: [{ chapterNo: 3, title: '（章节标题）', goal: '（本章目标）', beatIds: [], povCharacterId: 'c1', targetChars: 3000, endHook: '（结尾钩子）' }],
  };
}

function sampleBible(): StoryBible {
  return { ...emptyBible(), facts: ['（已确立的事实）'], openThreads: ['（未了线索）'], timeline: [{ chapterNo: 2, event: '（第2章发生的事）' }] };
}

const messagesOf = (m: ChatMessage[]) => ({
  system: m.filter((x) => x.role === 'system').map((x) => x.content).join('\n\n'),
  user: m.filter((x) => x.role === 'user').map((x) => x.content).join('\n\n'),
});

/**
 * 渲染全部模板。
 * @param authorNote 预览时把「作者附加指令」也拼进去，方便用户确认自己写的话落在哪一段。
 */
export function promptPreviews(authorNote = ''): PromptPreview[] {
  const req = SAMPLE_REQUIREMENTS(authorNote);
  const style = { profile: emptyStyleProfile({ id: 'p', name: '（文风档案名）' }), derivative: null, sourceTitle: null, authorNote };
  const doc = sampleDoc();
  const bible = sampleBible();
  const outline = OutlineDocSchema.parse({
    title: '（书名）',
    logline: '（全书主线：人物面对的目标、阻碍与选择）',
    characters: [{ name: '（人物名）', role: '主角' }],
    arcs: [{ title: '（故事弧）', startChapterNo: 1, endChapterNo: 10 }],
    beats: [{ arcIndex: 0, title: '（情节点）', suggestedChapterNo: 3 }],
  });

  const specs: Array<[string, string, string, { messages: ChatMessage[]; temperature?: number }]> = [
    ['write_chapter', '写正文', '每写一章都会用；上下文、文风、篇幅都在这里给出。',
      writeChapterPrompt({ chapterNo: 3, requirements: req, contextUserText: SAMPLE_CONTEXT, targetChars: 3000, caps: CAPS, style })],
    ['rewrite_chapter', '改写 / 定点修订', '故事线改动后重写，以及审校不通过时的定点修订。',
      rewriteChapterPrompt({ chapterNo: 3, requirements: req, contextUserText: SAMPLE_CONTEXT, oldText: SAMPLE_TEXT, instructions: ['（要改的第一处）', '（要改的第二处）'], mode: 'revise', targetChars: 3000, caps: CAPS, style })],
    ['adjust_length', '扩写 / 精简', '字数偏离目标太多时自动触发，也可以在章节页手动点。',
      lengthAdjustPrompt({ chapterNo: 3, requirements: req, chapterText: SAMPLE_TEXT, actual: 2400, target: 3000, mode: 'expand', chapterPlanText: '（本章计划）', caps: CAPS, style })],
    ['outline', '写大纲', '规划页第一步：人物、设定、故事弧、情节点。',
      outlinePrompt({ premise: '（故事前提）', requirements: req, targetChars: 120_000, chapterCount: 40 })],
    ['chapter_table', '排章节表', '规划页第二步：每章写什么、多少字。长书会分批。',
      chapterTablePrompt({ outline, requirements: req, fromChapter: 1, toChapter: 10, totalChapters: 40, batchTotalChars: 30_000, minChars: 2000, maxChars: 4500, previousEntries: [] })],
    ['summarize', '总结与故事圣经', '每章写完后跑一次，维护摘要、人物状态、时间线。',
      summarizePrompt({ chapterNo: 3, chapterText: SAMPLE_TEXT, bibleBefore: bible, doc })],
    ['style_review', '风格审校', '有文风档案时，逐章评「像不像」与人物是否出戏。',
      styleReviewPrompt({ chapterNo: 3, chapterText: SAMPLE_TEXT, profile: emptyStyleProfile({ id: 'p', name: '（文风档案名）' }), characters: doc.characters, derivative: emptyDerivative(), sourceTitle: '（原著书名）', canonFacts: ['（既定事实）'], metricHints: ['（本地统计发现的问题）'], qcReminders: ['（本类型的质检重点）'] })],
    ['consistency_review', '设定校对', '与风格审校相互独立：只查数值、时间线、称呼、设定规则。',
      consistencyReviewPrompt({ chapterNo: 3, chapterText: SAMPLE_TEXT, facts: ['（既定事实）'], rules: [{ name: '（规则名）', description: '（规则说明）', scope: '本书' }], timeline: ['第2章：（发生的事）'], characters: doc.characters, qcReminders: ['（质检重点）'] })],
    ['extract_style', '拆书（提取文风）', '从已有正文里归纳这本书的腔调、示例段与禁忌。',
      styleExtractPrompt({ title: '（作品名）', excerpts: [{ chapterNo: 1, text: SAMPLE_TEXT }], knownCharacterNames: ['（人物名）'], metricsHint: '（本地统计出的句长、段长、标点习惯）' })],
    ['rewrite_plan', '生成改写说明', '故事线改动后，替每一章写出「这一章要改什么」。',
      rewritePlanPrompt({ diffSummary: '（故事线的改动摘要）', items: [{ chapterNo: 3, mode: 'revise', reasons: ['（为什么要改）'], planText: '（本章计划）' }] })],
    ['passage_discuss', '阅读器里讨论段落', '在阅读器选中一段问 AI 时使用。',
      passageDiscussPrompt({ selectedText: '（选中的段落）', pageNo: 12, before: '（上文）', after: '（下文）', question: '（你的问题）', history: [], docTitle: '（文档名）' })],
  ];

  return specs.map(([id, label, when, spec]) => ({ id, label, when, temperature: spec.temperature ?? 0, ...messagesOf(spec.messages) }));
}
