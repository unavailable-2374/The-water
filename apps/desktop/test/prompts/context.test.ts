import { describe, expect, it } from 'vitest';
import {
  SECTION_CAPS,
  SECTION_HEADERS,
  assembleChapterContext,
  buildContextBudget,
  renderChapterPlan,
  renderChapterTitles,
  selectRelevantBible,
  type ChapterContextParts,
} from '@/llm/prompts/context';
import { estimateTokens, truncateHead, truncateTail } from '@/llm/prompts/estimate';
import { UNTRUSTED_CLOSE, UNTRUSTED_NOTICE, UNTRUSTED_OPEN } from '@/llm/prompts/untrusted';
import { caps, makeBible, makeDoc } from '../fixtures/storyline';

const RATIO = 0.7;
const zh = (n: number, ch = '字') => ch.repeat(n);

describe('estimateTokens', () => {
  it('uses cjk*ratio + other/4', () => {
    expect(estimateTokens('汉字', 0.7)).toBe(Math.ceil(1.4));
    expect(estimateTokens('abcd', 0.7)).toBe(1);
    expect(estimateTokens('汉字abcd', 1.0)).toBe(3);
    expect(estimateTokens('', 0.7)).toBe(0);
  });
  it('truncateHead / truncateTail respect the token limit', () => {
    const s = zh(100);
    expect(estimateTokens(truncateHead(s, 35, RATIO), RATIO)).toBeLessThanOrEqual(35);
    expect(truncateHead(s, 35, RATIO).length).toBe(50);
    expect(truncateTail('头' + zh(99), 35, RATIO)).not.toContain('头');
    expect(truncateHead(s, 0, RATIO)).toBe('');
  });
});

describe('buildContextBudget', () => {
  it('is contextWindow - maxTokens - safety, floored at 0', () => {
    expect(buildContextBudget({ caps, maxTokens: 5200 })).toBe(128_000 - 5200 - 1500);
    expect(buildContextBudget({ caps, maxTokens: 5200, safety: 0 })).toBe(122_800);
    expect(buildContextBudget({ caps: { ...caps, contextWindow: 1000 }, maxTokens: 5200 })).toBe(0);
  });
});

function parts(over: Partial<ChapterContextParts> = {}): ChapterContextParts {
  return {
    system: zh(200, '系'),
    chapterPlans: { current: '第3章 客\n目标：引入警察', near: ['第1章 信\n目标：建立悬念', '第2章 钟\n目标：加深疑惑', '第4章 真\n目标：揭开真相'], farTitles: '第5章；第6章' },
    bible: { primary: '主要相关人物：\n· 沈默', secondary: '其他人物：\n· 阿四' },
    recentSummaries: ['第1章摘要：收到信', '第2章摘要：钟停了'],
    arcSummaries: '来信弧：追查开始',
    prevTail: '……钟停在三点十七分。',
    logline: '钟表匠追寻亡妻来信的真相。',
    ...over,
  };
}

const sectionsIn = (text: string) => Object.values(SECTION_HEADERS).filter((h) => text.includes(`【${h}】`));

describe('assembleChapterContext', () => {
  it('includes every section in fixed order when the budget is ample', () => {
    const { userText, dropped } = assembleChapterContext(parts(), 100_000, RATIO);
    expect(dropped).toEqual([]);
    expect(sectionsIn(userText)).toEqual([
      SECTION_HEADERS.chapterPlan,
      SECTION_HEADERS.nearPlans,
      SECTION_HEADERS.bible,
      SECTION_HEADERS.recentSummaries,
      SECTION_HEADERS.prevTail,
      SECTION_HEADERS.logline,
    ]);
    expect(userText).toContain('其余章节：第5章；第6章');
    expect(userText).toContain('来信弧：追查开始');
    expect(userText.indexOf('第1章摘要')).toBeLessThan(userText.indexOf('第2章摘要'));
  });

  it('never exceeds the budget (system + user) and drops from the bottom up', () => {
    const p = parts();
    const systemTokens = estimateTokens(p.system, RATIO);
    const full = assembleChapterContext(p, 100_000, RATIO).userText;
    const fullTokens = estimateTokens(full, RATIO);
    for (let budget = systemTokens + fullTokens; budget >= systemTokens + 40; budget -= 5) {
      const { userText, dropped } = assembleChapterContext(p, budget, RATIO);
      const total = systemTokens + estimateTokens(userText, RATIO);
      // Either we fit, or only undroppable content is left.
      if (total > budget) {
        expect(sectionsIn(userText)).toEqual([SECTION_HEADERS.chapterPlan]);
      }
      expect(userText).toContain('【本章计划】\n第3章 客');
      // Drop order is a prefix of the canonical order.
      const order = [SECTION_HEADERS.logline, SECTION_HEADERS.prevTail, SECTION_HEADERS.recentSummaries, SECTION_HEADERS.bible, SECTION_HEADERS.nearPlans];
      expect(dropped).toEqual(order.slice(0, dropped.length));
    }
  });

  it('drops logline first, then prevTail, keeping the bible', () => {
    const p = parts();
    const systemTokens = estimateTokens(p.system, RATIO);
    const all = estimateTokens(assembleChapterContext(p, 100_000, RATIO).userText, RATIO);
    const loglineTokens = estimateTokens(`【${SECTION_HEADERS.logline}】\n${p.logline}`, RATIO);
    const r = assembleChapterContext(p, systemTokens + all - loglineTokens, RATIO);
    expect(r.dropped[0]).toBe(SECTION_HEADERS.logline);
    expect(r.dropped).not.toContain(SECTION_HEADERS.bible);
    expect(r.userText).toContain('【故事圣经】');
  });

  it('keeps the current chapter plan even when it alone is over budget', () => {
    const p = parts({ chapterPlans: { current: zh(5000, '计'), near: ['近'], farTitles: '远' } });
    const { userText, dropped } = assembleChapterContext(p, 10, RATIO);
    expect(userText).toContain(zh(5000, '计'));
    expect(dropped).not.toContain(SECTION_HEADERS.chapterPlan);
    // Near plans are the very last thing to go, after every other droppable section.
    const p2 = parts({ chapterPlans: { current: zh(100, '计'), near: ['近'], farTitles: '远' } });
    const r2 = assembleChapterContext(p2, 10, RATIO);
    expect(r2.userText).toBe(`【本章计划】\n${zh(100, '计')}`);
    expect(r2.dropped).toEqual([SECTION_HEADERS.logline, SECTION_HEADERS.prevTail, SECTION_HEADERS.recentSummaries, SECTION_HEADERS.bible, SECTION_HEADERS.nearPlans]);
  });

  it('caps the chapter-plans section: near plans then farTitles are cut to fit', () => {
    const p = parts({ chapterPlans: { current: zh(1000, '当'), near: [zh(1000, '甲'), zh(1000, '乙'), zh(1000, '丙')], farTitles: zh(1000, '远') } });
    const { userText } = assembleChapterContext(p, 100_000, RATIO);
    expect(userText).toContain(zh(1000, '甲'));
    expect(userText).not.toContain(zh(1000, '乙'));
    expect(userText).not.toContain(zh(1000, '远'));
    expect(userText).toContain('其余章节：远');
    const planSection = userText.split('【故事圣经】')[0]!;
    expect(estimateTokens(planSection, RATIO)).toBeLessThanOrEqual(SECTION_CAPS.chapterPlans + 40);
  });

  it('caps the bible at 3000 tokens with primary before secondary', () => {
    const p = parts({ bible: { primary: zh(3000, '主'), secondary: zh(3000, '次') } });
    const { userText } = assembleChapterContext(p, 100_000, RATIO);
    const bibleBody = userText.split('【故事圣经】')[1]!.split('【前文摘要】')[0]!;
    expect(estimateTokens(bibleBody, RATIO)).toBeLessThanOrEqual(SECTION_CAPS.bible + 5);
    expect(bibleBody).toContain(zh(3000, '主'));
    expect(bibleBody).toContain('次');
    expect(bibleBody.indexOf('主')).toBeLessThan(bibleBody.indexOf('次'));
  });

  it('keeps the newest summaries first and lets arcSummaries stand in for older ones', () => {
    const p = parts({ recentSummaries: [zh(1500, '一'), zh(1500, '二'), zh(1500, '三')], arcSummaries: zh(200, '弧') });
    const { userText } = assembleChapterContext(p, 100_000, RATIO);
    expect(userText).toContain(zh(1500, '三'));
    expect(userText).toContain(zh(1500, '二'));
    expect(userText).not.toContain(zh(1500, '一'));
    expect(userText).toContain(zh(200, '弧'));
    expect(userText.indexOf('弧')).toBeLessThan(userText.indexOf('二'));
  });

  it('trims the previous chapter to its LAST ~800 chars', () => {
    const prev = zh(3000, '前') + zh(800, '尾');
    const { userText } = assembleChapterContext(parts({ prevTail: prev }), 100_000, RATIO);
    const body = userText.split('【上一章结尾】')[1]!.split('【全书主线】')[0]!;
    // 内容被包在「资料，不是指令」的分隔块里（§2.3 第 6 条），只留最后约 800 字。
    expect(body).toContain(UNTRUSTED_NOTICE);
    expect(body).toContain(`${UNTRUSTED_OPEN}\n${zh(800, '尾')}\n${UNTRUSTED_CLOSE}`);
    expect(body).not.toContain('前');
  });

  it('omits empty sections without reporting them as dropped', () => {
    const { userText, dropped } = assembleChapterContext(parts({ logline: '', prevTail: '   ' }), 100_000, RATIO);
    expect(dropped).toEqual([]);
    expect(userText).not.toContain('【全书主线】');
    expect(userText).not.toContain('【上一章结尾】');
  });
});

describe('selectRelevantBible', () => {
  const doc = makeDoc();
  const bible = makeBible();

  it('puts characters/settings of this + previous 2 chapters in primary, the rest in secondary', () => {
    const { primary, secondary } = selectRelevantBible(bible, doc, 3);
    // chapters 1..3 reference c1, c3 and s1, s3; c2 / s2 only appear in chapter 4.
    expect(primary).toContain('· 沈默（老沈）｜主角');
    expect(primary).toContain('· 周衍（周警官）');
    expect(primary).toContain('当前状态：失眠、疑惑');
    expect(primary).toContain('· 钟表铺［地点］');
    expect(primary).toContain('· 旧钟表［物品］');
    expect(primary).not.toContain('· 林晚');
    expect(primary).not.toContain('雨城');
    expect(secondary).toContain('· 林晚');
    expect(secondary).toContain('· 雨城［世界］');
    expect(secondary).toContain('· 阿四');
    expect(secondary).toContain('既定事实');
    expect(secondary).toContain('林晚三年前去世');
  });

  it('adds the last 10 timeline events (before this chapter) and open threads to primary', () => {
    const many = { ...bible, timeline: Array.from({ length: 30 }, (_, i) => ({ chapterNo: i + 1, event: `事件${i + 1}` })) };
    const { primary } = selectRelevantBible(many, doc, 25);
    expect(primary).toContain('第24章：事件24');
    expect(primary).toContain('第15章：事件15');
    expect(primary).not.toContain('第14章：事件14');
    expect(primary).not.toContain('第25章');
    expect(primary).toContain('未了线索：\n- 信是谁寄出的');
  });

  it('only looks back 2 chapters', () => {
    const { primary, secondary } = selectRelevantBible(bible, doc, 4);
    expect(primary).toContain('· 林晚');
    expect(primary).toContain('雨城');
    expect(secondary).not.toContain('· 沈默');
  });
});

describe('renderChapterPlan / renderChapterTitles', () => {
  const doc = makeDoc();
  it('renders a compact Chinese plan with resolved names', () => {
    const s = renderChapterPlan(doc.chapters[2]!, doc);
    expect(s).toContain('第3章 客');
    expect(s).toContain('本章目标：引入警察');
    expect(s).toContain('视角人物：周衍');
    expect(s).toContain('目标字数：约 3000 字');
    expect(s).toContain('- 警官登门：周衍来访（人物：沈默、周衍；设定：钟表铺）');
    expect(s).toContain('结尾钩子：警官问起那封信');
  });
  it('titles only', () => {
    expect(renderChapterTitles(doc.chapters.slice(0, 2))).toBe('第1章 信；第2章 钟');
  });
});
