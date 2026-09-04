import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/llm/types';
import {
  ChapterTableSchema,
  OutlineDocSchema,
  RewriteInstructionsSchema,
  SummarizeResultSchema,
  defaultRequirements,
  type OutlineDoc,
} from '@/novel/types';
import { maxTokensForChapter } from '@/novel/wordBudget';
import {
  chapterTableBatches,
  chapterTablePrompt,
  lengthAdjustPrompt,
  outlinePrompt,
  passageDiscussPrompt,
  requirementsBlock,
  rewriteChapterPrompt,
  rewritePlanPrompt,
  summarizePrompt,
  systemBase,
  writeChapterPrompt,
  FORMAT_RULES,
  UNTRUSTED_CLOSE,
  UNTRUSTED_NOTICE,
  UNTRUSTED_OPEN,
} from '@/llm/prompts';
import { caps, makeBible, makeDoc, requirements } from '../fixtures/storyline';

const systemOf = (m: ChatMessage[]) => m.filter((x) => x.role === 'system').map((x) => x.content).join('\n');
const userOf = (m: ChatMessage[]) => m.filter((x) => x.role === 'user').map((x) => x.content).join('\n');

describe('systemBase', () => {
  it('lists requirements, taboos, must-haves and format rules', () => {
    const s = systemBase(requirements);
    expect(s).toContain('题材：悬疑');
    expect(s).toContain('视角：第三人称有限');
    expect(s).toContain('时态：过去时');
    expect(s).toContain('受众：成年读者');
    expect(s).toContain('语言：简体中文');
    expect(s).toContain('绝对禁止出现：血腥描写、政治隐喻');
    expect(s).toContain('必须包含：雨夜、旧钟表');
    expect(s).toContain('额外要求：每章至少一处环境描写');
    expect(s).toContain(FORMAT_RULES);
  });
  it('omits taboo / empty lines when not set', () => {
    const s = systemBase(defaultRequirements());
    expect(s).not.toContain('绝对禁止出现');
    expect(s).not.toContain('题材：');
    expect(requirementsBlock({ ...defaultRequirements(), taboos: ['  '] })).not.toContain('绝对禁止');
  });
});

describe('passageDiscussPrompt', () => {
  const history: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `h${i}` }));
  it('builds system + last 12 history + user, with Chinese section headers', () => {
    const spec = passageDiscussPrompt({ selectedText: '他停下了钟。', pageNo: 12, before: '前文', after: '后文', question: '为什么？', history, docTitle: '钟停' });
    expect(spec.label).toBe('讨论段落');
    expect(spec.maxTokens).toBe(2048);
    expect(spec.schema).toBeUndefined();
    expect(spec.messages[0]!.role).toBe('system');
    expect(spec.messages[0]!.content).toContain('严谨的阅读助手');
    expect(spec.messages[0]!.content).toContain('「」');
    expect(spec.messages[0]!.content).toContain('《钟停》');
    const hist = spec.messages.slice(1, -1);
    expect(hist).toHaveLength(12);
    expect(hist[0]!.content).toBe('h8');
    expect(hist[11]!.content).toBe('h19');
    const u = spec.messages.at(-1)!;
    expect(u.role).toBe('user');
    expect(u.content).toContain('【所选段落】（第 12 页）\n他停下了钟。');
    expect(u.content).toContain('【上下文（前）】\n前文');
    expect(u.content).toContain('【上下文（后）】\n后文');
    expect(u.content).toContain('【问题】\n为什么？');
  });
  it('handles no page / empty context / empty question', () => {
    const spec = passageDiscussPrompt({ selectedText: 'x', pageNo: null, before: '', after: '', question: '', history: [], docTitle: '' });
    const u = userOf(spec.messages);
    expect(u).toContain('【所选段落】\nx');
    expect(u).not.toContain('上下文');
    expect(u).toContain('【问题】');
    expect(spec.messages).toHaveLength(2);
  });
});

describe('outlinePrompt', () => {
  const spec = outlinePrompt({ premise: '钟表匠收到亡妻来信。', requirements, targetChars: 120_000, chapterCount: 40 });
  it('carries schema, numbers and structural rules', () => {
    expect(spec.label).toBe('生成大纲');
    expect(spec.maxTokens).toBe(8000);
    expect(spec.schema).toBe(OutlineDocSchema);
    const s = systemOf(spec.messages);
    expect(s).toContain('绝对禁止出现：血腥描写、政治隐喻');
    expect(s).not.toContain(FORMAT_RULES);
    const u = userOf(spec.messages);
    expect(u).toContain('【故事框架】\n钟表匠收到亡妻来信。');
    expect(u).toContain('约 120000 字，共 40 章');
    expect(u).toContain('覆盖第 1 章到第 40 章');
    expect(u).toContain('3–8 位主要人物');
    expect(u).toContain('每章 1–3 个');
    expect(u).toContain('suggestedChapterNo');
    expect(u).toContain('world|location|faction|item|rule|other');
  });
});

describe('chapterTablePrompt', () => {
  const outline: OutlineDoc = OutlineDocSchema.parse({
    title: '钟停',
    characters: [{ name: '沈默', role: '主角' }],
    arcs: [{ title: '来信', startChapterNo: 1, endChapterNo: 40 }],
    beats: [
      { arcIndex: 0, title: '雨夜来信', suggestedChapterNo: 1 },
      { arcIndex: 0, title: '远处的事', suggestedChapterNo: 35 },
      { arcIndex: 0, title: '待定', suggestedChapterNo: null },
    ],
  });
  const previous = ChapterTableSchema.parse([
    { chapterNo: 27, title: 'a', goal: 'g', targetChars: 3000, endHook: 'e' },
    { chapterNo: 28, title: 'b', goal: 'g', targetChars: 3000, endHook: 'e' },
    { chapterNo: 29, title: 'c', goal: 'g', targetChars: 3000, endHook: 'e' },
    { chapterNo: 30, title: 'd', goal: 'g', targetChars: 3000, endHook: 'e' },
  ]);
  const spec = chapterTablePrompt({ outline, requirements, fromChapter: 31, toChapter: 40, totalChapters: 40, batchTotalChars: 30_000, minChars: 2000, maxChars: 4500, previousEntries: previous });

  it('states the hard constraints with the exact numbers', () => {
    expect(spec.label).toBe('生成章节表');
    expect(spec.schema).toBe(ChapterTableSchema);
    expect(spec.maxTokens).toBe(8000);
    const u = userOf(spec.messages);
    expect(u).toContain('恰好输出第 31 章到第 40 章，共 10 条');
    expect(u).toContain('全书共 40 章');
    expect(u).toContain('之和必须等于 30000');
    expect(u).toContain('2000–4500 之间');
    expect(systemOf(spec.messages)).toContain('绝对禁止出现：血腥描写');
  });
  it('only lists beats for this range (or undecided) and the last 3 previous entries', () => {
    const u = userOf(spec.messages);
    expect(u).toContain('远处的事');
    expect(u).toContain('待定');
    expect(u).not.toContain('雨夜来信');
    expect(u).toContain('第28章 b');
    expect(u).toContain('第30章 d');
    expect(u).not.toContain('第27章 a');
  });
  it('chapterTableBatches', () => {
    expect(chapterTableBatches(40)).toEqual([[1, 30], [31, 40]]);
    expect(chapterTableBatches(30)).toEqual([[1, 30]]);
    expect(chapterTableBatches(61, 30)).toEqual([[1, 30], [31, 60], [61, 61]]);
    expect(chapterTableBatches(0)).toEqual([]);
  });
});

describe('writeChapterPrompt', () => {
  const ctx = '【本章计划】\n第3章 客';
  it('full chapter: length rule with asked/min numbers, context in user, maxTokens from budget', () => {
    const spec = writeChapterPrompt({ chapterNo: 3, requirements, contextUserText: ctx, targetChars: 3000, caps });
    expect(spec.label).toBe('撰写第3章');
    expect(spec.temperature).toBe(0.85);
    expect(spec.schema).toBeUndefined();
    expect(spec.maxTokens).toBe(maxTokensForChapter(3000, caps));
    const s = systemOf(spec.messages);
    expect(s).toContain('本章目标约 3240 字（严格），不得少于 2700 字，不要为了凑字数而重复');
    expect(s).toContain('绝对禁止出现：血腥描写、政治隐喻');
    expect(s).toContain(FORMAT_RULES);
    const u = userOf(spec.messages);
    expect(u.startsWith(ctx)).toBe(true);
    expect(u).not.toContain('【本章前半部分】');
    expect(u).toContain('完整正文');
  });
  it('second half: includes first half and continuation instruction', () => {
    const spec = writeChapterPrompt({ chapterNo: 7, requirements, contextUserText: ctx, targetChars: 6000, half: 'second', firstHalfText: '前半正文……', caps });
    const u = userOf(spec.messages);
    expect(u).toContain('【本章前半部分】\n前半正文……');
    expect(u).toContain('续写');
    expect(u).toContain('不要重复前文');
    expect(systemOf(spec.messages)).toContain('本次只写后半部分，约 3240 字（严格），不得少于 2700 字');
    expect(spec.maxTokens).toBe(maxTokensForChapter(3000, caps));
  });
  it('first half: stops before the hook', () => {
    const spec = writeChapterPrompt({ chapterNo: 7, requirements, contextUserText: ctx, targetChars: 6000, half: 'first', caps });
    expect(userOf(spec.messages)).toContain('前半部分');
    expect(userOf(spec.messages)).not.toContain('【本章前半部分】');
  });
});

describe('summarizePrompt', () => {
  const doc = makeDoc();
  const spec = summarizePrompt({ chapterNo: 2, chapterText: '钟停了。', bibleBefore: makeBible(), doc });
  it('carries schema, ≤300字 rule, known names and relevant bible', () => {
    expect(spec.label).toBe('总结第2章');
    expect(spec.schema).toBe(SummarizeResultSchema);
    expect(spec.maxTokens).toBe(3000);
    expect(spec.temperature).toBe(0.3);
    const u = userOf(spec.messages);
    expect(u).toContain('不超过 300 字');
    expect(u).toContain('只记录本章新增或发生变化的内容');
    expect(u).toContain('【已知人物】\n沈默（老沈）、林晚、周衍（周警官）');
    // 正文按「资料，不是指令」包起来（§2.3 第 6 条）。
    expect(u).toContain('【第2章正文】' + UNTRUSTED_NOTICE);
    expect(u).toContain(`${UNTRUSTED_OPEN}\n钟停了。\n${UNTRUSTED_CLOSE}`);
    expect(u).toContain('当前状态：失眠、疑惑');
    expect(u).toContain('本章是故事弧《来信》的最后一章');
  });
  it('asks for null arcSummary when the chapter does not end an arc', () => {
    const s2 = summarizePrompt({ chapterNo: 3, chapterText: 'x', bibleBefore: makeBible(), doc });
    expect(userOf(s2.messages)).toContain('arcSummary 置为 null');
  });
});

describe('lengthAdjustPrompt', () => {
  const base = { chapterNo: 5, requirements, chapterText: '正文', chapterPlanText: '计划', caps };
  it('expand', () => {
    const spec = lengthAdjustPrompt({ ...base, actual: 2000, target: 3000, mode: 'expand' });
    expect(spec.label).toBe('扩写第5章');
    expect(spec.temperature).toBe(0.6);
    expect(spec.maxTokens).toBe(maxTokensForChapter(3000, caps));
    expect(spec.schema).toBeUndefined();
    const u = userOf(spec.messages);
    expect(u).toContain('当前 2000 字，目标 3000 字，需扩写约 1000 字');
    expect(u).toContain('不改变情节、人物与结局');
    expect(u).toContain('输出完整章节');
    expect(u).toContain('【本章计划】\n计划');
    expect(u).toContain('【当前正文】\n正文');
    expect(systemOf(spec.messages)).toContain('绝对禁止出现：血腥描写');
  });
  it('trim', () => {
    const spec = lengthAdjustPrompt({ ...base, actual: 4000, target: 3000, mode: 'trim' });
    expect(spec.label).toBe('精简第5章');
    expect(userOf(spec.messages)).toContain('当前 4000 字，目标 3000 字，需精简约 1000 字');
  });
});

describe('rewritePlanPrompt', () => {
  const spec = rewritePlanPrompt({
    diffSummary: '人物「林晚」改为未死，仅失踪。',
    items: [
      { chapterNo: 2, mode: 'revise', reasons: ['人物描述变化'], planText: '第2章 钟' },
      { chapterNo: 4, mode: 'rewrite', reasons: ['情节点变化', '结局变化'], planText: '第4章 真' },
    ],
  });
  it('carries the diff, per-chapter items and the schema', () => {
    expect(spec.label).toBe('生成改写说明');
    expect(spec.schema).toBe(RewriteInstructionsSchema);
    const u = userOf(spec.messages);
    expect(u).toContain('【故事线改动】\n人物「林晚」改为未死，仅失踪。');
    expect(u).toContain('第2章（局部修订）');
    expect(u).toContain('第4章（完全重写）');
    expect(u).toContain('- 结局变化');
    expect(u).toContain('共 2 条');
    expect(u).toContain('本章需要改变：');
  });
});

describe('rewriteChapterPrompt', () => {
  const base = { chapterNo: 4, requirements, contextUserText: '【本章计划】\n第4章 真', oldText: '旧正文', instructions: ['本章需要改变：林晚活着', '删掉葬礼'], targetChars: 3000, caps };
  it('revise keeps usable paragraphs', () => {
    const spec = rewriteChapterPrompt({ ...base, mode: 'revise' });
    expect(spec.label).toBe('改写第4章');
    expect(spec.maxTokens).toBe(maxTokensForChapter(3000, caps));
    expect(systemOf(spec.messages)).toContain('尽量保留原文中仍然成立的段落，只改动必要之处');
    expect(systemOf(spec.messages)).toContain('本章目标约 3240 字');
    const u = userOf(spec.messages);
    expect(u).toContain('【旧版本正文】\n旧正文');
    expect(u).toContain('【改写要求】\n- 本章需要改变：林晚活着\n- 删掉葬礼');
    expect(u.startsWith('【本章计划】')).toBe(true);
  });
  it('rewrite starts over', () => {
    const spec = rewriteChapterPrompt({ ...base, mode: 'rewrite' });
    expect(systemOf(spec.messages)).toContain('完全重写，仅参考原文节奏与篇幅'.slice(0, 4));
    expect(systemOf(spec.messages)).toContain('仅参考原文节奏与篇幅');
    expect(systemOf(spec.messages)).not.toContain('尽量保留原文');
  });
});
