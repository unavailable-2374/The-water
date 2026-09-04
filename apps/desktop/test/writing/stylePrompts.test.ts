import { describe, expect, it } from 'vitest';
import { emptyDerivative, emptyStyleProfile, emptyVoice, type StyleProfile } from '@the-water/shared';
import { systemBase } from '@/llm/prompts/base';
import { UNTRUSTED_GUARD_RULE } from '@/llm/prompts/untrusted';
import { constraintsFromTargets, pickExemplars, renderDerivativeNotice, renderStyleSummary, renderStyleUserBlock } from '@/llm/prompts/style';
import { SECTION_CAPS, SECTION_HEADERS, assembleChapterContext, renderVoiceLine, selectRelevantBible, triggeredSettings } from '@/llm/prompts/context';
import { writeChapterPrompt } from '@/llm/prompts/writeChapter';
import { outlinePrompt } from '@/llm/prompts/outline';
import { applyExtractToProfile, mergeStyleExtracts, styleExtractPrompt, StyleExtractResultSchema } from '@/llm/prompts/styleExtract';
import { reviewToInstructions, styleReviewPrompt, StyleReviewResultSchema } from '@/llm/prompts/styleReview';
import { caps, makeBible, makeDoc, requirements } from '../fixtures/storyline';

function profile(): StyleProfile {
  const p = emptyStyleProfile({ id: 'sp', name: '江湖味' });
  p.injection.humanReadableConstraints = ['动作段用 5–10 字短句', '对白用「道」不用「说」'];
  p.voice.narrator = { text: '第三人称贴身视角，叙述者克制。', evidence: ['他没有答话。'] };
  p.voice.signatureMoves = [{ move: '章末一句短评', example: '这一夜，没有人睡。', frequencyPerChapter: [0, 1] }];
  p.exemplars = [
    { id: 'e1', sceneType: 'fight', text: '刀出。人退。灯灭了。'.repeat(8), illustrates: ['rhythm'] },
    { id: 'e2', sceneType: 'dialogue', text: '“你来了。”“来了。”'.repeat(8), illustrates: ['dialogue'] },
    { id: 'e3', sceneType: 'quiet', text: '风从檐角过，带着铁锈味。'.repeat(8), illustrates: ['imagery'] },
  ];
  p.negatives.avoidWords = ['OK', '尴尬'];
  p.negatives.avoidPatterns = ['眼底闪过一丝'];
  p.negatives.antiExemplars = [{ text: '他的心中涌起一股难以言喻的悲伤。', why: '直接写情绪' }];
  return p;
}

describe('renderStyleSummary', () => {
  it('puts constraints first, then voice, then signature moves with frequency', () => {
    const s = renderStyleSummary(profile());
    expect(s.startsWith('【文风：江湖味】')).toBe(true);
    expect(s.indexOf('动作段用')).toBeLessThan(s.indexOf('叙述腔调'));
    expect(s).toContain('招牌动作：章末一句短评（每章 0–1 次，不要更多）');
  });
  it('never exceeds summaryBudget', () => {
    const p = profile();
    p.injection.summaryBudget = 80;
    p.injection.humanReadableConstraints = Array.from({ length: 20 }, (_, i) => `第${i}条很长很长的约束，占很多字数，绝不能全部塞进去`);
    const body = renderStyleSummary(p).split('\n').slice(1).join('\n');
    expect(Array.from(body).length).toBeLessThanOrEqual(80);
    expect(body.length).toBeGreaterThan(0);
  });
  it('returns empty for an empty profile', () => {
    expect(renderStyleSummary(emptyStyleProfile({}))).toBe('');
  });
});

describe('exemplars & user block', () => {
  it('prefers same scene type, then fills up to exemplarCount', () => {
    const p = profile();
    p.injection.exemplarCount = 2;
    expect(pickExemplars(p, 'dialogue').map((e) => e.id)).toEqual(['e2', 'e1']);
    expect(pickExemplars(p, null).map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(pickExemplars(p, 'fight', 0)).toEqual([]);
  });
  it('renders exemplars and negatives', () => {
    const u = renderStyleUserBlock(profile(), 'quiet');
    expect(u).toContain('不要照抄内容');
    expect(u.indexOf('风从檐角过')).toBeLessThan(u.indexOf('刀出'));
    expect(u).toContain('不要出现这些词：OK、尴尬');
    expect(u).toContain('不要用这些句式：眼底闪过一丝');
    expect(u).toContain('反例（不要这样写）');
    expect(renderStyleUserBlock(emptyStyleProfile({}), null)).toBe('');
  });
  it('constraintsFromTargets writes human sentences', () => {
    const p = profile();
    p.targets = { ...p.targets, sentenceMean: [12, 20], dialogueRatio: [0.3, 0.5], exclamationPerK: [0, 2] };
    const c = constraintsFromTargets(p);
    expect(c).toContain('句子平均 12–20 字，长短交错');
    expect(c.some((x) => x.includes('30%–50%'))).toBe(true);
    expect(c.some((x) => x.includes('感叹号每千字不超过 2 个'))).toBe(true);
  });
});

describe('systemBase with style extras and doc type', () => {
  it('appends derivative notice + style summary, keeps format rules last', () => {
    const d = { ...emptyDerivative(), kind: 'au' as const, divergencePoint: '第 12 章之后', mustKeep: ['主角性格'], allowedChanges: ['配角结局'] };
    const s = systemBase(requirements, { profile: profile(), derivative: d, sourceTitle: '例·江湖' });
    expect(s).toContain('【二创声明】');
    expect(s).toContain('《例·江湖》的平行世界');
    expect(s).toContain('必须保持不变：主角性格');
    expect(s).toContain('允许改动：配角结局');
    expect(s.indexOf('【二创声明】')).toBeLessThan(s.indexOf('【文风：江湖味】'));
    // 输出格式仍在最后一段；再往后只跟一条「资料不是指令」的防注入声明（§2.3 第 6 条）。
    expect(s).toContain('使用中文标点。');
    expect(s.trim().endsWith(UNTRUSTED_GUARD_RULE)).toBe(true);
    expect(s.indexOf('使用中文标点。')).toBeLessThan(s.indexOf(UNTRUSTED_GUARD_RULE));
  });
  it('injects doc-type writing rules and a non-fiction role', () => {
    const s = systemBase({ ...requirements, docType: 'news' });
    expect(s).toContain('擅长新闻稿');
    expect(s).toContain('【新闻稿·写法】');
    expect(s).toContain('第三人称、过去时');
    expect(systemBase(requirements)).toContain('【长篇小说·写法】');
  });
  it('renderDerivativeNotice adapts to audience', () => {
    expect(renderDerivativeNotice({ ...emptyDerivative(), audience: 'general' }, null)).toContain('没读过原著');
  });
  it('writeChapterPrompt threads style into the system message', () => {
    const spec = writeChapterPrompt({ chapterNo: 3, requirements, contextUserText: 'ctx', targetChars: 3000, caps, style: { profile: profile() } });
    expect(spec.messages[0]!.content).toContain('【文风：江湖味】');
  });
  it('outlinePrompt includes the doc type framework', () => {
    const spec = outlinePrompt({ premise: 'x', requirements: { ...requirements, docType: 'short-story' }, targetChars: 20000, chapterCount: 5 });
    const u = spec.messages[1]!.content;
    expect(u).toContain('结构框架（短篇小说：Save the Cat 八拍）');
    expect(u).toContain('故事核一句话');
  });
});

describe('context: style section, voice lines, lorebook', () => {
  const base = {
    system: 'sys',
    chapterPlans: { current: '第3章', near: [], farTitles: '' },
    bible: { primary: '主要相关人物：\n· 沈默', secondary: '' },
    recentSummaries: ['第2章：钟停了'],
    arcSummaries: '',
    prevTail: '上一章的结尾。',
    logline: '主线',
    style: '以下是原著段落：\n刀出。人退。',
  };
  it('includes the style section between summaries and prevTail', () => {
    const { userText } = assembleChapterContext(base, 100_000, 0.7);
    const i = (h: string) => userText.indexOf(`【${h}】`);
    expect(i(SECTION_HEADERS.style)).toBeGreaterThan(i(SECTION_HEADERS.recentSummaries));
    expect(i(SECTION_HEADERS.style)).toBeLessThan(i(SECTION_HEADERS.prevTail));
  });
  it('drops style after logline/prevTail but before summaries and bible', () => {
    const big = { ...base, style: '示'.repeat(SECTION_CAPS.style), recentSummaries: ['摘'.repeat(1500)], bible: { primary: '圣'.repeat(2500), secondary: '' } };
    const budget = Math.ceil((2 + 1 + 2500 + 1500 + 60) * 0.7) + 60;
    const { dropped, userText } = assembleChapterContext(big, budget, 0.7);
    expect(dropped).toEqual([SECTION_HEADERS.logline, SECTION_HEADERS.prevTail, SECTION_HEADERS.style]);
    expect(userText).toContain('【前文摘要】');
  });
  it('renders voice lines only for primary characters', () => {
    const doc = makeDoc();
    doc.characters[0] = { ...doc.characters[0]!, speechSamples: ['你来了。', '不喝。'], verbalTics: ['罢了'], addressBook: { 自称: '在下' }, redlines: ['不解释动机'] };
    doc.characters[2] = { ...doc.characters[2]!, speechSamples: ['警察办案。'] };
    const { primary, secondary } = selectRelevantBible(makeBible(), doc, 1);
    expect(primary).toContain('说话样本：「你来了。」 「不喝。」');
    expect(primary).toContain('口癖：罢了');
    expect(primary).toContain('称呼：自称→在下');
    expect(primary).toContain('绝不会：不解释动机');
    expect(secondary).toContain('周衍');
    expect(secondary).not.toContain('警察办案');
    expect(renderVoiceLine(emptyVoice())).toBe('');
  });
  it('lorebook: trigger keys and constant entries become primary, sorted by priority', () => {
    const doc = makeDoc();
    doc.settings.push({ id: 's9', name: '递刀礼', kind: 'rule', description: '递刀即托付性命', triggerKeys: ['递刀'], priority: 90, constant: false });
    doc.settings.push({ id: 's8', name: '货币', kind: 'rule', description: '一两银子十贯钱', triggerKeys: [], priority: 60, constant: true });
    doc.settings.push({ id: 's7', name: '无关', kind: 'other', description: '不会命中', triggerKeys: ['龙宫'], priority: 99, constant: false });
    const { primary, secondary } = selectRelevantBible(makeBible(), doc, 1, '第2章：他递刀给师父');
    expect(primary).toContain('递刀礼');
    expect(primary).toContain('货币');
    expect(primary.indexOf('递刀礼')).toBeLessThan(primary.indexOf('货币'));
    expect(secondary).toContain('无关');
    expect(triggeredSettings(doc.settings, '', new Set()).map((s) => s.id)).toEqual(['s8']);
  });
});

describe('styleExtract', () => {
  it('prompt lists excerpts, known names and metrics hint; schema tolerates sloppy output', () => {
    const spec = styleExtractPrompt({ title: '江湖', excerpts: [{ chapterNo: 2, text: '刀出。' }], knownCharacterNames: ['沈默'], metricsHint: '平均句长 12' });
    const u = spec.messages[1]!.content;
    expect(u).toContain('〔第2章〕');
    expect(u).toContain('沈默');
    expect(u).toContain('平均句长 12');
    expect(spec.schema).toBe(StyleExtractResultSchema);
    const parsed = StyleExtractResultSchema.parse({ voice: { narrator: 'x' }, exemplars: [{ sceneType: 'weird', text: 'abc' }], lore: [{ name: 'a', kind: 'nope', content: 'c' }] });
    expect(parsed.exemplars[0]!.sceneType).toBe('other');
    expect(parsed.lore[0]!.kind).toBe('rule');
  });
  it('merges batches and applies to a profile', () => {
    const a = StyleExtractResultSchema.parse({ voice: { rhythm: '短句' }, evidence: { rhythm: ['刀出。'] }, exemplars: [{ sceneType: 'fight', text: '刀'.repeat(80), illustrates: ['rhythm'] }], humanReadableConstraints: ['短句'], avoidWords: ['OK'], characters: [{ name: '沈默', speechSamples: ['你来了。'], redlines: ['不哭'] }], lore: [{ name: '递刀礼', kind: 'rule', triggerKeys: ['递刀'], content: 'x' }], signatureMoves: [{ move: '章末短评', example: 'e', perChapter: 1 }] });
    const b = StyleExtractResultSchema.parse({ voice: { rhythm: '长短交错' }, exemplars: [{ sceneType: 'fight', text: '刀'.repeat(80) }, { sceneType: 'quiet', text: '风'.repeat(80) }], humanReadableConstraints: ['短句', '少用感叹号'], avoidWords: ['OK', '尴尬'], characters: [{ name: '沈默', speechSamples: ['不喝。'], verbalTics: ['罢了'] }], lore: [{ name: '递刀礼', kind: 'rule', triggerKeys: [], content: 'dup' }] });
    const m = mergeStyleExtracts([a, b]);
    expect(m.voice.rhythm).toBe('短句 长短交错');
    expect(m.exemplars).toHaveLength(2);
    expect(m.humanReadableConstraints).toEqual(['短句', '少用感叹号']);
    expect(m.avoidWords).toEqual(['OK', '尴尬']);
    expect(m.characters[0]).toMatchObject({ name: '沈默', speechSamples: ['你来了。', '不喝。'], verbalTics: ['罢了'], redlines: ['不哭'] });
    expect(m.lore).toHaveLength(1);
    const p = applyExtractToProfile(emptyStyleProfile({ id: 'x' }), m, [1, 2]);
    expect(p.source.kind).toBe('extracted');
    expect(p.source.chaptersSampled).toEqual([1, 2]);
    expect(p.voice.rhythm.evidence).toEqual(['刀出。']);
    expect(p.voice.signatureMoves[0]!.frequencyPerChapter).toEqual([0, 2]);
    expect(p.exemplars.map((e) => e.id)).toEqual(['ex1', 'ex2']);
    expect(p.negatives.avoidWords).toEqual(['OK', '尴尬']);
  });
});

describe('styleReview', () => {
  it('prompt carries profile summary, character specs, facts and revise threshold', () => {
    const doc = makeDoc();
    doc.characters[0] = { ...doc.characters[0]!, speechSamples: ['你来了。'], redlines: ['不解释动机'] };
    const spec = styleReviewPrompt({ chapterNo: 2, chapterText: '正文', profile: profile(), characters: doc.characters, derivative: { ...emptyDerivative(), styleFidelity: 0.9, mustKeep: ['主角性格'] }, sourceTitle: '江湖', canonFacts: ['林晚三年前去世'], metricHints: ['句子偏长'], qcReminders: ['称呼是否出错'] });
    const u = spec.messages[1]!.content;
    expect(u).toContain('【文风：江湖味】');
    expect(u).toContain('· 沈默｜说话样本：「你来了。」｜红线：不解释动机');
    expect(u).toContain('林晚三年前去世');
    expect(u).toContain('styleScore 低于 90');
    expect(u).toContain('称呼是否出错');
    expect(spec.temperature).toBeLessThan(0.5);
  });
  it('reviewToInstructions orders metric → OOC → canon → drift → AI tells', () => {
    const r = StyleReviewResultSchema.parse({ styleScore: 50, driftFindings: [{ quote: '长句', why: '太长', suggest: '拆开' }], ooc: [{ character: '沈默', quote: '我错了', verdict: 'OOC', redline: '不认错' }, { character: '周衍', quote: 'x', verdict: 'neutral' }], canonConflicts: ['小指未断'], aiTells: ['总之'], verdict: 'revise' });
    const ins = reviewToInstructions(r, ['句子偏长']);
    expect(ins[0]).toBe('句子偏长');
    expect(ins[1]).toContain('沈默出戏（红线：不认错）');
    expect(ins[2]).toContain('与既定事实矛盾：小指未断');
    expect(ins[3]).toContain('不像原著');
    expect(ins[4]).toContain('去掉 AI 味：总之');
  });
});
