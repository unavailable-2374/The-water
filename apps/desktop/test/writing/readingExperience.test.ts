import { attachSimulatedOutlineReview } from '../helpers/outlineReview';
/** TEST fixtures validate planning/data contracts, not real reader responses or model quality. */
import { beforeEach, describe, expect, it } from 'vitest';
import { WritingBriefSchema } from '@the-water/shared';
import { useTestDb } from '../helpers/testDb';
import { createNovel } from '@/db/repos/novelsRepo';
import { upsertChapterPlan } from '@/db/repos/chaptersRepo';
import { listWritingCards, saveWritingCard } from '@/db/repos/writingRepo';
import { buildStorylineDoc } from '@/db/repos/storylineRepo';
import { buildChapterContextText } from '@/jobs/steps/common';
import { defaultRequirements, OutlineDocSchema } from '@/novel/types';
import { chapterTablePrompt } from '@/llm/prompts/chapterTable';
import { outlinePrompt } from '@/llm/prompts/outline';
import { systemBase } from '@/llm/prompts/base';
import { applyOutline } from '@/novel/planning';
import { acceptDocumentPlan } from '@/db/repos/planProposalsRepo';
import { remapMaterialCard } from '@/sync/fork';

const legacy = { premise: 'TEST premise', mainline: 'TEST goal', ending: 'TEST ending', audience: 'TEST reader', constraints: [], rollingChapters: 5 };
const brief = { ...legacy, readingExperience: 'TEST 经营改善生活', distinctiveApproach: 'TEST 修理旧物', protagonistLimits: 'TEST 材料有限', firstChoice: 'TEST 修复旧阵盘', choiceConsequences: 'TEST 发现缺陷牵动师徒关系', storyEngine:'TEST 修复发现责任，承担责任引出选择',endingConditions:'TEST 修复故障与重建信任'  };
const outlineFields = { logline: 'TEST mainline', arcs: [{ title: 'TEST arc', startChapterNo: 1, endChapterNo: 1 }] };
beforeEach(() => useTestDb());

describe('TEST reading experience persists through authoring and context', () => {
  it('accepts legacy briefs without inventing new content and validates new fields', () => {
    expect(WritingBriefSchema.parse(legacy)).toEqual(legacy);
    expect(WritingBriefSchema.parse(brief)).toEqual(brief);
    expect(WritingBriefSchema.safeParse({ ...brief, firstChoice: 123 }).success).toBe(false);
    expect(WritingBriefSchema.safeParse({ ...brief, readingExperience: 'x'.repeat(12001) }).success).toBe(false);
  });
  it('round-trips confirmed cards, includes them in chapter context, and preserves them when forking', async () => {
    const novel = await createNovel({ title: 'TEST', premise: 'TEST', requirements: defaultRequirements(), targetChars: 1000 });
    const chapter = await upsertChapterPlan(novel.id, { chapterNo: 1, targetChars: 1000 });
    const id = await saveWritingCard(novel.id, { kind: 'brief', data: brief }, { confirmed: true });
    const cards = await listWritingCards(novel.id);
    expect(cards.find(c => c.id === id)?.data).toEqual(brief);
    expect(remapMaterialCard({ kind: 'brief', data: brief }, new Map()).data).toEqual(brief);
    const doc = await buildStorylineDoc(novel.id, novel.premise, []);
    const provider = { id: 'TEST', kind: 'openai_compatible' as const, model: 'TEST', caps: { contextWindow: 64000, maxOutputTokens: 4000, jsonMode: 'json_object' as const, cjkTokenRatio: 0.7 }, async *stream() { throw new Error('TEST no model calls'); } };
    const context = await buildChapterContextText({ novel, chapter, chapters: [chapter], doc, bible: { characters: {}, facts: [], timeline: [], openThreads: [], arcSummaries: {}, styleNotes: '' }, snapshotId: null }, provider, 2000);
    for (const value of Object.values(brief).filter(v => typeof v === 'string')) expect(context).toContain(value);
  });
  it('keeps generated briefs as proposals until adoption and feeds confirmed materials to legacy outline planning', async () => {
    const novel = await createNovel({ title: 'TEST', premise: 'TEST', requirements: defaultRequirements(), targetChars: 1000 });
    const outline = OutlineDocSchema.parse({ ...outlineFields, title: 'TEST', characters:[{name:'TEST 甲',role:'主角'}], writing: { brief, volumes: [], intents: [{characterName:'TEST 甲',goal:'TEST 目标',motivation:'TEST 动机',contradiction:'TEST 矛盾',fear:'TEST 失去信任',belief:'TEST 保护就是代为决定',habitualStrategy:'TEST 隐瞒危险',independentAgenda:'TEST 主角不在也会修船',growth:[]}] } });
    const proposalId = await applyOutline(novel.id, outline);
    expect(await listWritingCards(novel.id, { confirmed: true })).toHaveLength(0);
    await attachSimulatedOutlineReview(novel.id,proposalId);await acceptDocumentPlan(novel.id,proposalId);
    const cards = await listWritingCards(novel.id, { confirmed: true });
    expect(cards.find(card=>card.kind==='brief')!.data).toEqual(brief);
    const intent=cards.find(card=>card.kind==='character');
    if (!intent || intent.kind!=='character') throw new Error('TEST expected character goal card');
    expect(intent.data).toMatchObject({fear:'TEST 失去信任',belief:'TEST 保护就是代为决定',habitualStrategy:'TEST 隐瞒危险',independentAgenda:'TEST 主角不在也会修船'});
    const forked=remapMaterialCard({kind:intent.kind,data:intent.data} as Parameters<typeof remapMaterialCard>[0],new Map([[intent.data.characterId,'TEST forked character']]));
    expect(forked.data).toMatchObject({fear:'TEST 失去信任',independentAgenda:'TEST 主角不在也会修船'});
    const prompt = chapterTablePrompt({ outline: OutlineDocSchema.parse({ ...outlineFields, title: 'TEST legacy outline' }), writingCards: cards, requirements: defaultRequirements(), fromChapter: 1, toChapter: 1, totalChapters: 1, batchTotalChars: 1000, minChars: 500, maxChars: 1500, previousEntries: [] });
    expect(prompt.messages.at(-1)!.content).toContain(brief.readingExperience);
    expect(prompt.messages.at(-1)!.content).toContain('规划约束，非既成事实');
  });
  it('passes the planning brief into chapter tables and scopes prose guidance to long fiction', () => {
    const requirements = defaultRequirements();
    const outline = OutlineDocSchema.parse({ ...outlineFields, title: 'TEST', writing: { brief, volumes: [], intents: [] } });
    const prompt = chapterTablePrompt({ outline, requirements, fromChapter: 1, toChapter: 1, totalChapters: 1, batchTotalChars: 1000, minChars: 500, maxChars: 1500, previousEntries: [] });
    expect(prompt.messages.at(-1)!.content).toContain(brief.choiceConsequences);
    expect(outlinePrompt({ premise: 'TEST', requirements, targetChars: 1000, chapterCount: 1 }).messages.at(-1)!.content).toContain('readingExperience');
    expect(systemBase(requirements)).toContain('不反复撤回谜底');
    expect(systemBase({ ...requirements, docType: 'tech-blog' })).not.toContain('不反复撤回谜底');
    const mixed = chapterTablePrompt({ outline, requirements: { ...requirements, genrePackIds: ['urban', 'xianxia', 'mystery'] }, fromChapter: 1, toChapter: 1, totalChapters: 1, batchTotalChars: 1000, minChars: 500, maxChars: 1500, previousEntries: [] });
    expect(mixed.messages.at(-1)!.content).toContain('真实事件时间线');
    expect(mixed.messages.at(-1)!.content).toContain('具体职业任务');
    expect(mixed.messages.at(-1)!.content).toContain('关键能力表');
  });
});
