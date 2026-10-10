/** TEST / SIMULATED model outputs. Real SQLite transactions; no literary-quality claims. */
import { testQualityAudit } from '../helpers/storyOptionAudit';
import { simulatedOutlineReview } from '../helpers/outlineReview';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import * as completion from '@/llm/complete';
import { assistantRequest } from '@/novel/assistant';
import { requestStoryJson } from '@/novel/storyIntelligence';
import { canonicalJson, AssistantContextSchema, AssistantOperationSchema, type StoryOptionBatch, type StoryOptionScope } from '@the-water/shared';
import { createRun, sessionFor, revision, getRun, changesFor, undoOperation } from '@/assistant/repository';
import { executeOperation } from '@/assistant/operations';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotDatabase } from '@/db/backup';
import { createTestDb } from '../helpers/testDb';
import { useTestDb } from '../helpers/testDb';
import { testScene } from '../helpers/writing';
import { createNovel, getNovel, updateNovel } from '@/db/repos/novelsRepo';
import { createVersion, getChapter, getVersion, upsertChapterPlan } from '@/db/repos/chaptersRepo';
import { buildStorylineDoc, upsertArc } from '@/db/repos/storylineRepo';
import { getStoryGraph, saveStoryGraph } from '@/db/repos/storyGraphRepo';
import { listWritingCards, saveWritingCard, discardProposal } from '@/db/repos/writingRepo';
import { acceptDocumentPlan, listDocumentPlans } from '@/db/repos/planProposalsRepo';
import { optionBatch, optionHistory, optionCards, recoverStoryOptions, optionSignature, storyDirectionContext } from '@/db/repos/storyOptionsRepo';
import { generateStoryOptions, retainStoryOption, resumeStoryOptions, selectStoryOption, generateStoryOptionPlan, storyOptionSource, combineStoryOptions } from '@/novel/storyOptions';
import { undoStoryOption } from '@/novel/storyOptionAdoption';
import { createNovelFromWizard } from '@/novel/service';
import { defaultRequirements } from '@/novel/types';
import { PLOT_DESIGN_RULE, PLOT_PLANNING_RULE, PLOT_REVIEW_RULE } from '@/novel/plotDesign';
import { OUTLINE_EXPLORATION_RULE } from '@/novel/outlineQuality';
import { createJob, getJob } from '@/db/repos/jobsRepo';
import { upgradeWizardDraft, WIZARD_DRAFT_KEY } from '@/novel/wizardDraft';
import { getSetting, setSetting } from '@/db/repos/settingsRepo';

const simulated = vi.hoisted(() => ({ reply: vi.fn() }));
vi.mock('@/llm/json', async importOriginal => ({ ...await importOriginal<typeof import('@/llm/json')>(), requestJson: async (_provider: unknown, spec: { schema: { parse: (v: unknown) => unknown }; messages: { content: string }[] }) => {
  const value = await simulated.reply(spec);
  if (spec.messages[1]!.content.startsWith('统一比较单卡')) {
    const source = JSON.parse(spec.messages[1]!.content.split('\n').find(line => line.startsWith('{"scope":'))!).source;
    source.citations = [...source.eventCitations, ...source.summaryCitations];
    value.options = value.options.map((o: any) => ({ ...o, findings: o.findings.map((f: any, i: number) => ({ checkpoint: o.qualityAudit.find((a: any) => a.findingIndices.includes(i))?.checkpoint ?? "resolutionSetup", kind: f.kind, citationId: source.citations.find((c: any) => c.field === f.field && c.quote === f.quote)?.id ?? 'TEST INVALID CITATION', authorCitationId: source.authorCitations.find((c: any) => c.quote === f.authorQuote)?.id ?? 'none', explanation: f.explanation, revision: f.revision })), qualityAudit: o.qualityAudit.map((a: any) => ({ checkpoint: a.checkpoint, notApplicable: a.status === "not_applicable", explanation: a.explanation, evidenceIds: a.evidence.map((e: any) => source.citations.find((c: any) => c.field === e.field && c.quote === e.quote)?.id ?? 'TEST INVALID CITATION') })) }));
  }
  let output = value;
  if (spec.messages[1]!.content.startsWith('生成恰好') && !('phases' in value)) {
    const source = JSON.parse(spec.messages[1]!.content.split('\n').find(line => line.startsWith('{"scope":'))!).source;
    const count = source.strategyBlueprint?.phases.length ?? 1;
    const events = value.events ?? value.options[0]?.outline?.map((situation: string, i: number) => ({ phaseIndex: source.strategyBlueprint ? Math.floor(i / 2) : 0, situation, choice: 'TEST SIMULATED concrete action and motivation', resources: [], response: 'TEST SIMULATED independent response to the action', result: 'TEST SIMULATED actual result of the action', lastingChange: 'TEST SIMULATED lasting consequence of the result' }));
    output = { phases: Array.from({ length: count }, (_, phaseIndex) => ({ events: events?.filter((e: any) => e.phaseIndex === phaseIndex).map(({ phaseIndex: _index, ...event }: any) => event) })) };
  }
  return { value: spec.schema.parse(output), usage: { inputTokens: 10, outputTokens: 20 } };
} }));
vi.mock('@/jobs/runner', async importOriginal => ({ ...await importOriginal<typeof import('@/jobs/runner')>(), providersForPurposes: async () => { const provider = { id: null, kind: 'openai_compatible', model: 'TEST SIMULATED', caps: { contextWindow: 1000000, maxOutputTokens: 20000, cjkTokenRatio: 1, jsonMode: 'json_schema' } }; return { planning: provider, writing: provider }; } }));

let db: ReturnType<typeof useTestDb>;
let planTransform: ((v: any) => any) | null;
beforeEach(() => { db = useTestDb(); planTransform = null; simulated.reply.mockReset(); simulated.reply.mockImplementation(reply); });
afterEach(() => db.raw.close());
const blueprint = (i: number) => ({ ...content(i).design, phases: Array.from({ length: 3 }, (_, p) => ({ goal: `TEST SIMULATED phase goal ${p}`, choice: `TEST SIMULATED phase choice ${p}`, consequence: `TEST SIMULATED phase consequence ${p}` })) });
const content = (i: number) => ({ design: { causalSpine: `TEST SIMULATED causal spine ${i}`, decisiveChoice: `TEST SIMULATED decisive choice ${i}`, resolutionMechanism: `TEST SIMULATED resolution ${i}` }, outline: Array.from({ length: 6 }, (_, act) => `TEST SIMULATED outline ${i}, act ${act}: the character makes a concrete choice and faces its consequences through a complete causal story.`),  title: `TEST SIMULATED option ${i}`, mainline: `TEST SIMULATED conflict ${i}`, conflict: 'TEST SIMULATED conflict', choiceAndCost: 'TEST SIMULATED choice cost', growth: 'TEST SIMULATED growth', turns: ['TEST SIMULATED turn'], ending: 'TEST SIMULATED outcome', aftermath: 'TEST SIMULATED consequence' });

it('TEST independent exploration excludes saved prose, arcs, author notes and adopted directions at every scope', async () => {
  const f = await fixture();
  await createVersion({ chapterId: f.chapters[0]!.id, content: 'TEST OLD PROSE SENTINEL', source: 'user_edit' });
  await setSetting(`authorNote:${f.novel.id}`, 'TEST OLD NOTE SENTINEL');
  for (const scope of [{ kind: 'work' as const, id: f.novel.id }, { kind: 'arc' as const, id: f.arc.id }, { kind: 'chapter' as const, id: f.chapters[0]!.id }, { kind: 'scene' as const, id: f.scene }]) {
    const source = await storyOptionSource(f.owner, scope, undefined, 'TEST EXPLICIT CHARACTER REQUIREMENT');
    expect(source.snapshot).not.toHaveProperty('doc');
    expect(source.snapshot).not.toHaveProperty('saved');
    expect(source.snapshot).not.toHaveProperty('signature');
    const id = await generateStoryOptions({ owner: f.owner, scope, authorMaterials: 'TEST EXPLICIT CHARACTER REQUIREMENT', requestKey: `TEST independent ${scope.kind}` });
    expect((await optionBatch(f.owner, id)).batch.boundary).toBeNull();
  }
  for (const [spec] of simulated.reply.mock.calls) {
    const prompt = spec.messages[1].content;
    expect(prompt).toContain('TEST EXPLICIT CHARACTER REQUIREMENT');
    const task = JSON.parse(prompt.split('【授权创作任务参数】\n')[1]!.split('\n')[0]!);
    expect(task.authorMaterials).toBe('TEST EXPLICIT CHARACTER REQUIREMENT');
    expect(spec.messages[0].content).toContain('其授权只限创作领域');
    expect(prompt).not.toContain('TEST OLD PROSE SENTINEL');
    expect(prompt).not.toContain('TEST OLD NOTE SENTINEL');
    expect(prompt).not.toContain('"doc":');
    expect(prompt).not.toContain('"directions":');
    expect(prompt).not.toContain('"signature":');
  }
});

it('TEST only each own abstract blueprint enters generation, excluding all other newly generated story text', async () => {
  const f = await fixture();
  const b = await generated(f);
  const cards = await optionCards(b);
  const generations = simulated.reply.mock.calls.map(([spec]) => spec).filter(s => s.messages[1].content.startsWith('生成恰好'));
  expect(generations).toHaveLength(4);
  for (let i = 0; i < generations.length; i++) {
    const source = JSON.parse(generations[i]!.messages[1].content.split('\n').find((line: string) => line.startsWith('{"scope":'))!).source;
    expect(source.strategyBlueprint).toEqual(blueprint(i));
    expect(source.retained).toEqual([]);
    expect(source).not.toHaveProperty('currentBatchDesigns');
    for (const other of cards.filter((_, index) => index !== i)) expect(JSON.stringify(source)).not.toContain(other.outline![0]!);
  }
});

it('TEST existing plan changes neither independent input hash nor candidate prompt and do not stale the batch', async () => {
  const f = await fixture(), scope = { kind: 'work' as const, id: f.novel.id };
  const before = await storyOptionSource(f.owner, scope), batch = await generated(f);
  await upsertArc(f.novel.id, { id: f.arc.id, title: 'TEST REPLACED OLD ARC', summary: 'TEST DIFFERENT OLD STORY', startChapterNo: 1, endChapterNo: 2 });
  await createVersion({ chapterId: f.chapters[0]!.id, content: 'TEST DIFFERENT OLD PROSE', source: 'user_edit' });
  const after = await storyOptionSource(f.owner, scope);
  expect(after).toEqual(before);
  expect((await optionHistory(f.owner, scope)).find(h => h.batch.id === batch.id)?.stale).toBe(false);
  const next = await generateStoryOptions({ owner: f.owner, scope, previousBatchId: batch.id, mode: batch.mode, requestKey: 'TEST independent redraw' });
  expect((await optionBatch(f.owner, next)).batch.inputSnapshot).not.toHaveProperty('previousOptions');
  const generations = simulated.reply.mock.calls.map(([spec]) => spec).filter(spec => spec.messages[1].content.startsWith('生成恰好'));
  expect(generations).toHaveLength(8);
  expect(generations[4].messages).toEqual(generations[0].messages);
});

it('TEST redraw sends only explicitly retained cards, excluding every rejected old candidate', async () => {
  const f = await fixture(), first = await generated(f), cards = await optionCards(first);
  await retainStoryOption(f.owner, first.id, cards[0]!.id, true);
  await generateStoryOptions({ owner: f.owner, scope: first.scope, previousBatchId: first.id, keep: true, requestKey: 'TEST retained isolation' });
  const spec = simulated.reply.mock.calls.map(([s]) => s).filter(s => s.messages[1].content.startsWith('生成恰好')).at(-1)!;
  expect(spec.messages[1].content).toContain(cards[0]!.title);
  for (const discarded of cards.slice(1)) expect(spec.messages[1].content).not.toContain(discarded.title);
});

it('TEST combines only chosen cards into one new immutable reviewed candidate and keeps all source cards unchanged', async () => {
  const f = await fixture(), first = await generated(f), original = await optionCards(first);
  const selectedIds = [original[0]!.id, original[2]!.id];
  const input = { owner: f.owner, batchId: first.id, optionIds: selectedIds, feedback: 'TEST retain first choice and third resolution', requestKey: 'TEST fusion' };
  const id = await combineStoryOptions(input), combined = (await optionBatch(f.owner, id)).batch;
  expect(combined.optionIds).toHaveLength(1);
  expect(combined.comparison?.options).toHaveLength(1);
  expect(combined.inputSnapshot.combinationSources).toEqual([original[0], original[2]]);
  expect(await optionCards(first)).toEqual(original);
  expect(await listDocumentPlans(f.novel.id)).toHaveLength(0);
  const prompt = simulated.reply.mock.calls.map(([s]) => s).filter(s => s.messages[1].content.startsWith('生成恰好')).at(-1)!.messages[1].content;
  expect(prompt).toContain(original[0]!.title);
  expect(prompt).toContain(original[2]!.title);
  expect(prompt).not.toContain(original[1]!.title);
  expect(prompt).not.toContain(original[3]!.title);
  const calls = simulated.reply.mock.calls.length;
  expect(await combineStoryOptions(input)).toBe(id);
  expect(simulated.reply.mock.calls.length).toBe(calls);
  await selectStoryOption(f.owner, id, combined.optionIds[0]!);
  expect(await listDocumentPlans(f.novel.id)).toHaveLength(1);
});

it('TEST refuses foreign, repeated or single-card combinations', async () => {
  const f = await fixture(), first = await generated(f), base = { owner: f.owner, batchId: first.id, requestKey: 'TEST invalid fusion' };
  for (const ids of [[first.optionIds[0]!], [first.optionIds[0]!, first.optionIds[0]!], [first.optionIds[0]!, 'TEST foreign card']]) {
    await expect(combineStoryOptions({ ...base, optionIds: ids })).rejects.toThrow('two to four');
  }
});

it('TEST combination comparison failures retain the one generated card and resume review without regeneration', async () => {
  const f = await fixture(), first = await generated(f);
  let fail = true;
  simulated.reply.mockImplementation(async spec => {
    const latest = await latestBatch();
    if (Array.isArray(latest.inputSnapshot.combinationSources) && spec.messages[1].content.startsWith('统一比较') && fail) throw new Error('TEST exact combination review failure');
    return reply(spec);
  });
  await expect(combineStoryOptions({ owner: f.owner, batchId: first.id, optionIds: first.optionIds.slice(0, 2), requestKey: 'TEST interrupted fusion' })).rejects.toThrow('TEST exact combination review failure');
  const failed = await latestBatch(), ids = [...failed.optionIds];
  expect(ids).toHaveLength(1);
  expect(failed.state).toBe('failed');
  const calls = simulated.reply.mock.calls.filter(([spec]) => spec.messages[1].content.startsWith('生成恰好')).length;
  fail = false;
  await resumeStoryOptions(f.owner, failed.id);
  const ready = (await optionBatch(f.owner, failed.id)).batch;
  expect(ready.optionIds).toEqual(ids);
  expect(ready.comparison?.options).toHaveLength(1);
  expect(simulated.reply.mock.calls.filter(([spec]) => spec.messages[1].content.startsWith('生成恰好'))).toHaveLength(calls);
});

it('TEST duplicate causal designs cannot pass as differentiated cards', async () => {
  const f = await fixture();
  simulated.reply.mockImplementation(async spec => { const value = await reply(spec); if (spec.messages[1].content.startsWith('提炼本卡')) value.design = { causalSpine: 'TEST SAME SPINE', decisiveChoice: 'TEST SAME CHOICE', resolutionMechanism: 'TEST SAME RESOLUTION' }; return value; });
  await expect(generated(f)).rejects.toThrow('至少在因果主干');
  expect((await latestBatch()).optionIds).toHaveLength(1);
});

it('TEST semantic review cannot mark cosmetic variants ready or allow selecting them', async () => {
  const f = await fixture();
  simulated.reply.mockImplementation(async spec => {
    const value = await reply(spec);
    if (spec.messages[1].content.startsWith('统一比较') && 'differences' in value && value.differences.length) value.differences[0]!.judgment = 'cosmetic';
    return value;
  });
  await expect(generated(f)).rejects.toThrow('Candidate differences are insufficient');
  const failed = await latestBatch();
  expect(failed.optionIds).toHaveLength(4);
  expect(failed.comparison?.differences?.[0]?.judgment).toBe('cosmetic');
  expect(failed.state).toBe('failed');
  await expect(selectStoryOption(f.owner, failed.id, failed.optionIds[0]!)).rejects.toThrow('Comparison incomplete');
});
async function latestBatch() { const rows = await db.select<{ json: string }>('SELECT json FROM story_option_batches ORDER BY rowid DESC LIMIT 1'); return JSON.parse(rows[0]!.json) as StoryOptionBatch; }

it('TEST canonical narratives remain unchanged and all displayed turns quote their own narrative', async () => {
  const f = await fixture(), batch = await generated(f), cards = await optionCards(batch);
  const narratives = batch.inputSnapshot.optionNarrativeDrafts as Record<string, { paragraphs: string[] }>;
  cards.forEach((card, i) => {
    expect(card.outline).toEqual(narratives[`initial:${i}`]!.paragraphs);
    for (const turn of card.turns) expect(card.outline!.some(p => p.includes(turn))).toBe(true);
  });
});

it('TEST invented extracted turns fail, and resume reuses the persisted narrative', async () => {
  const f = await fixture();
  simulated.reply.mockImplementationOnce(reply).mockImplementationOnce(reply).mockImplementationOnce(async spec => ({ ...await reply(spec), turns: [{ paragraphIndex: 0, quote: 'TEST INVENTED EVENT absent from narrative' }] }));
  await expect(generated(f)).rejects.toThrow('不能另造事件');
  const failed = await latestBatch();
  expect(failed.optionIds).toHaveLength(0);
  const narrative = failed.inputSnapshot.optionNarrativeDrafts;
  const generations = simulated.reply.mock.calls.filter(([s]) => s.messages[1].content.startsWith('生成恰好')).length;
  await resumeStoryOptions(f.owner, failed.id);
  const ready = (await optionBatch(f.owner, failed.id)).batch;
  expect((ready.inputSnapshot.optionNarrativeDrafts as any)['initial:0']).toEqual((narrative as any)['initial:0']);
  expect(simulated.reply.mock.calls.filter(([s]) => s.messages[1].content.startsWith('生成恰好'))).toHaveLength(generations + 3);
  expect(ready.state).toBe('ready');
});

it('TEST extraction cannot reorder canonical turning points', async () => {
  const f = await fixture();
  simulated.reply.mockImplementationOnce(reply).mockImplementationOnce(reply).mockImplementationOnce(async spec => { const value = await reply(spec); value.turns.reverse(); return value; });
  await expect(generated(f)).rejects.toThrow('转折按叙事段落先后排列');
});

it('TEST local cards preserve every canonical event even when extraction selects one turn', async () => {
  const f = await fixture();
  simulated.reply.mockImplementation(async spec => { const value = await reply(spec); if (spec.messages[1].content.startsWith('提炼本卡')) value.turns = value.turns.slice(0, 1); return value; });
  const id = await generateStoryOptions({ owner: f.owner, scope: { kind: 'scene', id: f.scene }, requestKey: 'TEST local canonical events' });
  const batch = (await optionBatch(f.owner, id)).batch;
  const narratives = batch.inputSnapshot.optionNarrativeDrafts as Record<string, { paragraphs: string[] }>;
  (await optionCards(batch)).forEach((card, i) => {
    expect(card.outline).toBeUndefined();
    expect(card.turns).toEqual(narratives[`initial:${i}`]!.paragraphs);
  });
});

const testEvent = (phaseIndex: number, i: number) => ({ phaseIndex, situation: content(0).outline[i]!, choice: 'TEST SIMULATED concrete choice with its reason', resources: [] as { holding: string; access: string; terms: string; scope: string; trigger: string }[], response: 'TEST SIMULATED autonomous response by another person', result: 'TEST SIMULATED actual outcome of this choice', lastingChange: 'TEST SIMULATED persistent consequence for the next event' });

it('TEST every planned whole-work phase must have two events', async () => {
  const f = await fixture();
  simulated.reply.mockImplementationOnce(reply).mockImplementationOnce(async () => ({ events: Array.from({ length: 6 }, (_, i) => testEvent(0, i)) }));
  await expect(generated(f)).rejects.toThrow('策略阶段 1 必须');
  expect((await latestBatch()).optionIds).toHaveLength(0);
});

it('TEST grouped output must include every planned phase', async () => {
  const f = await fixture();
  simulated.reply.mockImplementationOnce(reply).mockImplementationOnce(async () => ({ phases: Array.from({ length: 2 }, (_, phase) => ({ events: [testEvent(phase, phase * 2), testEvent(phase, phase * 2 + 1)] })) }));
  await expect(generated(f)).rejects.toThrow('策略阶段 2 必须');
});

it('TEST repeated event copies cannot fill the phase count', async () => {
  const f = await fixture();
  simulated.reply.mockImplementationOnce(reply).mockImplementationOnce(async () => ({ events: [0, 0, 1, 1, 2, 2].map(phase => testEvent(phase, phase * 2)) }));
  await expect(generated(f)).rejects.toThrow('不能复制同一事件');
});

it('TEST repeating the same sentence across event fields is rejected', async () => {
  const f = await fixture();
  simulated.reply.mockImplementationOnce(reply).mockImplementationOnce(async () => ({ events: Array.from({ length: 6 }, (_, i) => { const e = testEvent(Math.floor(i / 2), i); return { ...e, choice: e.situation }; }) }));
  await expect(generated(f)).rejects.toThrow('不能复制同一句填不同字段');
});

it('TEST resource ownership, access, terms, scope and trigger are all retained in the actual narrative', async () => {
  const f = await fixture();
  const resource = { holding: 'TEST SIMULATED resource belongs to the independent supplier', access: 'TEST SIMULATED supplier explicitly grants a bounded right', terms: 'TEST SIMULATED supplier receives payment for the granted right', scope: 'TEST SIMULATED right covers delivery only and never voting', trigger: 'TEST SIMULATED delivery occurs only after the payment clears' };
  simulated.reply.mockImplementationOnce(reply).mockImplementationOnce(async () => ({ events: Array.from({ length: 6 }, (_, i) => ({ ...testEvent(Math.floor(i / 2), i), resources: i === 0 ? [resource] : [] })) }));
  const batch = await generated(f), first = (await optionCards(batch))[0]!;
  for (const sentence of Object.values(resource)) expect(first.outline![0]).toContain(sentence);
});

it('TEST crash between event and narrative persistence resumes from saved events', async () => {
  const f = await fixture();
  simulated.reply.mockImplementationOnce(reply).mockImplementationOnce(reply).mockImplementationOnce(async () => { throw new Error('TEST SIMULATED metadata interruption'); });
  await expect(generated(f)).rejects.toThrow('TEST SIMULATED metadata interruption');
  const failed = await latestBatch();
  const events = failed.inputSnapshot.optionEventDrafts;
  const generations = simulated.reply.mock.calls.filter(([s]) => s.messages[1].content.startsWith('生成恰好')).length;
  // TEST crash simulation: first persistence committed, second persistence absent.
  delete failed.inputSnapshot.optionNarrativeDrafts;
  db.raw.prepare('UPDATE story_option_batches SET json=? WHERE id=?').run(JSON.stringify(failed), failed.id);
  await resumeStoryOptions(f.owner, failed.id);
  const ready = (await optionBatch(f.owner, failed.id)).batch;
  expect((ready.inputSnapshot.optionEventDrafts as any)['initial:0']).toEqual((events as any)['initial:0']);
  expect(simulated.reply.mock.calls.filter(([s]) => s.messages[1].content.startsWith('生成恰好'))).toHaveLength(generations + 3);
  expect(ready.state).toBe('ready');
});

it('TEST new drafts receive bounded evidenced repair, keep originals immutable and become ready only after fresh review', async () => {
  const f = await fixture();
  simulated.reply.mockImplementation(async spec => {
    const value = await reply(spec), b = await latestBatch();
    if (spec.messages[1].content.startsWith('统一比较单卡 1') && 'options' in value && !(b.inputSnapshot.optionRepairAttempts as Record<string, number> | undefined)?.[0]) {
      const item = value.options[0]!;
      const card = (await optionCards(b))[0]!;
      Object.assign(item, { findings: [{ kind: 'missing_information', field: 'ending', quote: card.ending, authorQuote: '', explanation: 'TEST SIMULATED missing core payoff', revision: 'TEST stage the payoff' }] });
      Object.assign(item.qualityAudit[1]!, { status: 'gap', findingIndices: [0] });
    }
    return value;
  });
  const b = await generated(f);
  expect(b.state).toBe('ready');
  expect(b.inputSnapshot.optionRepairAttempts).toEqual({ 0: 1 });
  const history = b.inputSnapshot.optionDraftHistory as { optionId: string; replacementId: string }[];
  expect(history).toHaveLength(1);
  expect(b.optionIds).not.toContain(history[0]!.optionId);
  expect(b.optionIds).toContain(history[0]!.replacementId);
  expect(await db.select('SELECT id FROM story_options WHERE id=?', [history[0]!.optionId])).toHaveLength(1);
  const repairs = simulated.reply.mock.calls.filter(([s]) => s.messages[1].content.startsWith('生成恰好 1 个修订'));
  expect(repairs).toHaveLength(1);
  const task = JSON.parse(repairs[0]![0].messages[1].content.split('【授权创作任务参数】\n')[1]!.split('\n')[0]!);
  expect(task.repairRequirements).toEqual([{ field: 'ending', problem: 'TEST SIMULATED missing core payoff', requestedRepair: 'TEST stage the payoff' }]);
  expect(simulated.reply.mock.calls.filter(([s]) => s.messages[1].content.startsWith('统一比较单卡 1'))).toHaveLength(2);
});

it('TEST second repair rebuilds from author input and own strategy without the flawed draft template', async () => {
  const f = await fixture();
  simulated.reply.mockImplementation(async spec => {
    const value = await reply(spec), b = await latestBatch();
    if (spec.messages[1].content.startsWith('统一比较单卡 1') && 'options' in value && ((b.inputSnapshot.optionRepairAttempts as Record<string, number> | undefined)?.[0] ?? 0) < 2) {
      const item = value.options[0]!, card = (await optionCards(b))[0]!;
      item.findings = [{ kind: 'missing_information', field: 'ending', quote: card.ending, authorQuote: '', explanation: 'TEST SIMULATED unresolved core event', revision: 'TEST rebuild the event chain' }];
      Object.assign(item.qualityAudit[1]!, { status: 'gap', findingIndices: [0] });
    }
    return value;
  });
  const b = await generated(f);
  expect(b.state).toBe('ready');
  expect(b.inputSnapshot.optionRepairAttempts).toEqual({ 0: 2 });
  expect(b.inputSnapshot.optionDraftHistory).toHaveLength(2);
  const repairs = simulated.reply.mock.calls.filter(([s]) => s.messages[1].content.startsWith('生成恰好 1 个修订'));
  expect(repairs).toHaveLength(2);
  const sources = repairs.map(([s]) => JSON.parse(s.messages[1].content.split('\n').find((line: string) => line.startsWith('{"scope":'))!).source);
  expect(sources[0]).toHaveProperty('currentDraft');
  expect(sources[1]).not.toHaveProperty('currentDraft');
  expect(sources[1].strategyBlueprint).toEqual(blueprint(0));
  expect(sources[1].review.findings[0].explanation).toBe('TEST SIMULATED unresolved core event');
  expect(sources[1].review).not.toHaveProperty('qualityAudit');
  expect(sources[1].review.findings[0]).not.toHaveProperty('quote');
});

it('TEST author-retained cards are never automatically rewritten to satisfy a new quality finding', async () => {
  const f = await fixture(), original = await generated(f), keptId = original.optionIds[0]!;
  const before = await db.select('SELECT json FROM story_options WHERE id=?', [keptId]);
  await retainStoryOption(f.owner, original.id, keptId, true);
  simulated.reply.mockImplementation(async spec => {
    const value = await reply(spec);
    if (spec.messages[1].content.startsWith('统一比较单卡') && 'options' in value && value.options[0]!.optionId === keptId) {
      const item = value.options[0]!;
      Object.assign(item, { findings: [{ kind: 'missing_information', field: 'ending', quote: 'TEST SIMULATED outcome', authorQuote: '', explanation: 'TEST SIMULATED core gap in retained card', revision: 'TEST redraw this retained card explicitly' }] });
      Object.assign(item.qualityAudit[1]!, { status: 'gap', findingIndices: [0] });
    }
    return value;
  });
  await expect(generateStoryOptions({ owner: f.owner, scope: { kind: 'work', id: f.novel.id }, previousBatchId: original.id, keep: true, requestKey: 'TEST retained quality failure' })).rejects.toThrow('Critical candidate quality gaps');
  expect((await latestBatch()).optionIds).toContain(keptId);
  expect((await latestBatch()).inputSnapshot.optionRepairAttempts).toBeUndefined();
  expect(await db.select('SELECT json FROM story_options WHERE id=?', [keptId])).toEqual(before);
});

it('TEST interrupted per-card review resumes without repeating completed reviews or regenerating cards', async () => {
  const f = await fixture(); let fail = true;
  simulated.reply.mockImplementation(async spec => {
    if (fail && spec.messages[1].content.startsWith('统一比较单卡 3')) throw new Error('TEST exact third-card review failure');
    return reply(spec);
  });
  await expect(generated(f)).rejects.toThrow('TEST exact third-card review failure');
  const failed = await latestBatch();
  expect(failed.inputSnapshot.optionReviewProgress).toHaveLength(2);
  expect(failed.state).toBe('failed');
  fail = false;
  await resumeStoryOptions(f.owner, failed.id);
  expect((await latestBatch()).state).toBe('ready');
  const prompts = simulated.reply.mock.calls.map(([spec]) => spec.messages[1].content);
  expect(prompts.filter(p => p.startsWith('生成恰好'))).toHaveLength(4);
  expect(prompts.filter(p => p.startsWith('统一比较单卡 1'))).toHaveLength(1);
  expect(prompts.filter(p => p.startsWith('统一比较单卡 2'))).toHaveLength(1);
  expect(prompts.filter(p => p.startsWith('统一比较差异'))).toHaveLength(1);
});

it('TEST core quality failure persists authentic cards and review, prevents selection and combination', async () => {
  const f = await fixture();
  simulated.reply.mockImplementation(async spec => {
    const value = await reply(spec);
    if (spec.messages[1].content.startsWith('统一比较单卡') && 'options' in value) {
      const item = value.options[0]!;
      const cards = await optionCards(await latestBatch());
      Object.assign(item, { findings: [{ kind: 'missing_information', field: 'ending', quote: cards[0]!.ending, authorQuote: '', explanation: 'TEST SIMULATED core payoff absent', revision: 'TEST stage the promised result' }] });
      Object.assign(item.qualityAudit[1]!, { status: 'gap', evidence: [], findingIndices: [0] });
    }
    return value;
  });
  await expect(generated(f)).rejects.toThrow('Critical candidate quality gaps');
  const failed = await latestBatch();
  expect(failed.optionIds).toHaveLength(4);
  expect(failed.comparison?.options[0]?.qualityAudit?.[1]?.status).toBe('gap');
  expect(failed.state).toBe('failed');
  await expect(selectStoryOption(f.owner, failed.id, failed.optionIds[0]!)).rejects.toThrow('Comparison incomplete');
  await expect(combineStoryOptions({ owner: f.owner, batchId: failed.id, optionIds: failed.optionIds.slice(0, 2), requestKey: 'TEST blocked combination' })).rejects.toThrow('Complete source comparison');
  const calls = simulated.reply.mock.calls.length;
  await expect(resumeStoryOptions(f.owner, failed.id)).rejects.toThrow('Critical candidate quality gaps');
  expect(simulated.reply.mock.calls).toHaveLength(calls);
});
async function reply(spec: { messages: { content: string }[] }) {
  const prompt = spec.messages[1]!.content;
  if (prompt.startsWith('请独立审查最终大纲')) return simulatedOutlineReview();
  const batch = await latestBatch();
  if (prompt.startsWith('规划本轮')) return { blueprints: Array.from({ length: Number(prompt.match(/本轮 (\d+)/)![1]) }, (_, i) => blueprint(i)) };
  if (prompt.startsWith('生成恰好')) return { options: Array.from({ length: Number(prompt.match(/恰好 (\d+)/)![1]) }, (_, i) => content(i + simulated.reply.mock.calls.length * 10)) };
  if (prompt.startsWith('提炼本卡')) { const source = JSON.parse(prompt.split('\n').find(line => line.startsWith('{"scope":'))!).source; const paragraphs = source.canonicalNarrative.map((p: any) => p.text); const index = Number(paragraphs[0].match(/outline (\d+)/)![1]); return { ...content(index), turns: paragraphs.slice(0, 4).map((quote: string, paragraphIndex: number) => ({ paragraphIndex, quote })) }; }
  if (prompt.startsWith('统一比较')) { const cards = await optionCards(batch); const single = prompt.match(/^统一比较单卡 (\d+)/); const reviewCards = single ? [cards[Number(single[1]) - 1]!] : cards; return { differences: reviewCards.flatMap((left, i) => reviewCards.slice(i + 1).map(right => ({ leftId: left.id, rightId: right.id, judgment: 'substantive', axes: (['causalSpine', 'decisiveChoice'] as const).map(axis => ({ axis, leftQuote: left.design![axis], rightQuote: right.design![axis], explanation: 'TEST SIMULATED substantive comparison' })) }))), summary: 'TEST SIMULATED editorial comparison', options: reviewCards.map(({ id: optionId }) => ({ optionId, qualityAudit: testQualityAudit(cards.find(c => c.id === optionId)!), conflict: 'TEST conflict', character: 'TEST character', turns: 'TEST turns', emotion: 'TEST emotion', ending: 'TEST ending', tradeoff: 'TEST SIMULATED tradeoff', checks: { fieldConsistency: 'TEST SIMULATED consistency', causality: 'TEST SIMULATED causality', characterRequirements: 'TEST SIMULATED requirements', payoffs: 'TEST SIMULATED payoffs', distinctness: 'TEST SIMULATED differences' }, findings: [], violations: [], requiresWiderScope: false })) }; }
  const rows = await db.select<{ novel_id: string; batch_id: string }>("SELECT novel_id,batch_id FROM story_option_selections WHERE state='planning' ORDER BY rowid DESC LIMIT 1");
  const s = rows[0]!, novel = (await getNovel(s.novel_id))!, actual = (await optionBatch({ novelId: novel.id }, s.batch_id)).batch;
  const after = await buildStorylineDoc(novel.id, novel.premise, novel.meta.themes), cards = await listWritingCards(novel.id);
  const scope = actual.scope;
  if (scope.kind === 'work' && after.arcs[0]) after.arcs[0].summary = 'TEST SIMULATED selected complete outline';
  if (scope.kind === 'arc') after.arcs.find(a => a.id === scope.id)!.summary = 'TEST SIMULATED new arc';
  const chapterId = scope.kind === 'chapter' ? scope.id : scope.kind === 'scene' ? cards.find(c => c.id === scope.id)!.chapterId : null;
  const no = chapterId ? (await getChapter(chapterId))!.chapterNo : after.chapters[0]?.chapterNo;
  if (scope.kind !== 'scene' && scope.kind !== 'work' && no) after.chapters.find(c => c.chapterNo === no)!.goal = 'TEST SIMULATED chosen direction';
  const card = scope.kind === 'scene' ? cards.find(c => c.id === scope.id) : cards.find(c => c.chapterId === chapterId);
  const plan = { after, title: novel.title, logline: scope.kind === 'work' ? 'TEST SIMULATED chosen mainline' : novel.meta.logline, cards: card?.kind === 'scene' ? [{ id: card.id, chapterId: card.chapterId, chapterNo: no, value: { kind: 'scene', data: { ...card.data, outcome: 'TEST SIMULATED chosen outcome' } } }] : [], downstreamImpact: ['TEST SIMULATED downstream effect'], requiresWiderScope: false };
  return planTransform ? planTransform(plan) : plan;
}
async function fixture() {
  const novel = await createNovel({ title: 'TEST novel', premise: 'TEST fictional framework', requirements: { ...defaultRequirements(), docType: 'short-story' }, targetChars: 3000 });
  const chapters = [];
  for (let n = 1; n <= 3; n++) chapters.push(await upsertChapterPlan(novel.id, { chapterNo: n, title: `TEST chapter ${n}`, goal: 'TEST goal', targetChars: 1000, beatIds: [], povCharacterId: null, endHook: 'TEST hook' }));
  const arc = await upsertArc(novel.id, { title: 'TEST arc', summary: 'TEST arc', startChapterNo: 1, endChapterNo: 2 });
  const scene = await testScene(novel.id, chapters[0]!.id);
  return { novel, chapters, arc, scene, owner: { novelId: novel.id } };
}
async function generated(f: Awaited<ReturnType<typeof fixture>>, scope: StoryOptionScope = { kind: 'work', id: f.novel.id }, mode: 'continue' | 'restructure' = 'continue') {
  const id = await generateStoryOptions({ owner: f.owner, scope, mode, requestKey: nanoid() });
  const { batch } = await optionBatch(f.owner, id); return batch;
}
async function proposalFor(f: Awaited<ReturnType<typeof fixture>>, scope?: StoryOptionScope, mode?: 'continue' | 'restructure') {
  const batch = await generated(f, scope, mode), selectionId = await selectStoryOption(f.owner, batch.id, batch.optionIds[0]!);
  return { batch, selectionId, proposal: (await listDocumentPlans(f.novel.id))[0]! };
}

it.each(['work','arc','chapter','scene'] as const)('TEST %s directions create one atomic review group without changing prose or plans', async kind => {
  const f = await fixture(), ids = { work: f.novel.id, arc: f.arc.id, chapter: f.chapters[0]!.id, scene: f.scene };
  const signature = await optionSignature(f.novel.id);
  const { proposal, selectionId } = await proposalFor(f, { kind, id: ids[kind] });
  for (const [spec] of simulated.reply.mock.calls) {
    const system = spec.messages[0].content as string;
    expect(system.split(PLOT_DESIGN_RULE)).toHaveLength(2);
    const independent = ['生成恰好', '规划本轮', '提炼本卡', '统一比较'].some(prefix => spec.messages[1].content.startsWith(prefix));
    expect(system).toContain(independent ? OUTLINE_EXPLORATION_RULE : spec.messages[1].content.startsWith('请独立审查最终大纲') ? PLOT_REVIEW_RULE : PLOT_PLANNING_RULE);
    if (independent) {
      expect(system).not.toContain('不能为制造复杂性擅加创伤、秘密、关系或事件');
      expect(system).not.toContain('不能照此新增设定或任务');
      expect(system).not.toContain(PLOT_PLANNING_RULE);
      expect(system).toContain('允许补全人物经历、动机、关系、行业、能力规则、资源安排、情节和结局');
    }
  }
  expect(await optionSignature(f.novel.id)).toBe(signature);
  expect(proposal.meta.storyOptionSelectionId).toBe(selectionId);
  await acceptDocumentPlan(f.novel.id, proposal.id);
  expect(await storyDirectionContext(f.novel.id)).toContain('TEST SIMULATED');
  await acceptDocumentPlan(f.novel.id, proposal.id); // idempotent
  await undoStoryOption(f.novel.id, selectionId);
  expect((await getChapter(f.chapters[0]!.id))!.goal).toBe('TEST goal');
  expect((await listWritingCards(f.novel.id)).find(c => c.id === f.scene)?.data).toHaveProperty('outcome', 'TEST outcome');
  expect(await storyDirectionContext(f.novel.id)).toBe('');
});
it('TEST keeps immutable cards, recomputes comparison and can select from a historical batch', async () => {
  const f = await fixture(), first = await generated(f), original = (await optionCards(first))[0]!;
  await retainStoryOption(f.owner, first.id, original.id, true);
  const secondId = await generateStoryOptions({ owner: f.owner, scope: first.scope, previousBatchId: first.id, keep: true, feedback: 'TEST preference', requestKey: 'TEST redraw' });
  const second = (await optionBatch(f.owner, secondId)).batch;
  expect(second.optionIds).toHaveLength(4); expect(await optionCards(second)).toContainEqual(original);
  expect(second.comparison?.options.map(c => c.optionId)).toEqual(second.optionIds);
  await expect(db.execute('UPDATE story_options SET json=? WHERE id=?', [JSON.stringify(original), original.id])).rejects.toThrow('immutable');
  await selectStoryOption(f.owner, first.id, first.optionIds[1]!);
  expect(await listDocumentPlans(f.novel.id)).toHaveLength(1);
});
it('TEST saves candidates when comparison fails and resumes only comparison after restart', async () => {
  const f = await fixture(); let fail = true;
  simulated.reply.mockImplementation(async spec => { if (spec.messages[1].content.startsWith('统一比较') && fail) throw new Error('TEST exact comparison failure'); return reply(spec); });
  await expect(generated(f)).rejects.toThrow('TEST exact comparison failure');
  const saved = await latestBatch(), ids = [...saved.optionIds];
  expect(ids).toHaveLength(4); expect(saved.error).toBe('TEST exact comparison failure'); expect(saved.comparison).toBeNull();
  fail = false; await recoverStoryOptions(); await resumeStoryOptions(f.owner, saved.id);
  expect((await optionBatch(f.owner, saved.id)).batch.optionIds).toEqual(ids);
  expect(simulated.reply.mock.calls.filter(([spec]) => spec.messages[1].content.startsWith('生成恰好'))).toHaveLength(4);
});
it('TEST duplicate concurrent generation and selection use one persisted request and proposal', async () => {
  const f = await fixture(), input = { owner: f.owner, scope: { kind: 'work' as const, id: f.novel.id }, requestKey: 'TEST duplicate' };
  const [a, b] = await Promise.all([generateStoryOptions(input), generateStoryOptions(input)]);
  expect(a).toBe(b); expect(simulated.reply).toHaveBeenCalledTimes(14);
  const { batch } = await optionBatch(f.owner, a);
  const selected = await Promise.all([selectStoryOption(f.owner, a, batch.optionIds[0]!), selectStoryOption(f.owner, a, batch.optionIds[0]!)]);
  expect(selected[0]).toBe(selected[1]); expect(await listDocumentPlans(f.novel.id)).toHaveLength(1);
});
it('TEST stale source, foreign work, locked scope and outside-scope plans are rejected', async () => {
  const f = await fixture(), first = await generated(f), other = await fixture();
  await expect(optionBatch(other.owner, first.id)).rejects.toThrow('belong');
  await updateNovel(f.novel.id, { premise: 'TEST changed hard framework' });
  expect((await optionHistory(f.owner, first.scope))[0]!.stale).toBe(true);
  await expect(selectStoryOption(f.owner, first.id, first.optionIds[0]!)).rejects.toThrow('Source changed');
  const graph = await getStoryGraph(f.novel.id); graph.graph.lockedNodeIds.push(f.scene); await saveStoryGraph(f.novel.id, graph.revision, graph.graph, 'TEST lock');
  const locked = await generated(f, { kind: 'scene', id: f.scene });
  await expect(selectStoryOption(f.owner, locked.id, locked.optionIds[0]!)).rejects.toThrow('locked');
  const chapterBatch = await generated(f, { kind: 'chapter', id: f.chapters[1]!.id });
  planTransform = p => ({ ...p, after: { ...p.after, chapters: p.after.chapters.map((c: any) => ({ ...c, goal: 'TEST illegal cross-scope change' })) } });
  await expect(selectStoryOption(f.owner, chapterBatch.id, chapterBatch.optionIds[0]!)).rejects.toThrow('outside scope');
  expect(await listDocumentPlans(f.novel.id)).toEqual([]);
});
it('TEST continue uses actual saved version and refuses earlier scope; restructure preserves prose', async () => {
  const f = await fixture(), version = await createVersion({ chapterId: f.chapters[1]!.id, content: 'TEST saved prose', source: 'user_edit' });
  const continuation = await generated(f, { kind: 'chapter', id: f.chapters[0]!.id });
  expect(continuation.boundary).toBeNull();
  expect(JSON.stringify(continuation.inputSnapshot)).not.toContain('TEST saved prose');
  await expect(selectStoryOption(f.owner, continuation.id, continuation.optionIds[0]!)).rejects.toThrow('precedes');
  const { proposal } = await proposalFor(f, { kind: 'chapter', id: f.chapters[0]!.id }, 'restructure');
  await acceptDocumentPlan(f.novel.id, proposal.id);
  expect((await getVersion((await getChapter(f.chapters[1]!.id))!.currentVersionId))!.content).toBe(version.content);
});
it('TEST atomic acceptance rolls back every plan and decision on a transaction failure', async () => {
  const f = await fixture(), { proposal } = await proposalFor(f, { kind: 'chapter', id: f.chapters[0]!.id });
  const signature = await optionSignature(f.novel.id);
  await expect(acceptDocumentPlan(f.novel.id, proposal.id, ops => db.atomic([...ops, { sql: "UPDATE novels SET title='TEST fail' WHERE id='TEST absent'", expectedRows: 1 }]))).rejects.toThrow('atomic precondition');
  expect(await optionSignature(f.novel.id)).toBe(signature);
  expect(await listDocumentPlans(f.novel.id)).toHaveLength(1); expect(await storyDirectionContext(f.novel.id)).toBe('');
});
it('TEST adoption CAS catches edits between validation and commit; undo refuses concurrent prose changes', async () => {
  const f = await fixture(), { proposal } = await proposalFor(f);
  await expect(acceptDocumentPlan(f.novel.id, proposal.id, async ops => { await updateNovel(f.novel.id, { premise: 'TEST race' }); await db.atomic(ops); })).rejects.toThrow('atomic precondition');
  expect(await listDocumentPlans(f.novel.id)).toHaveLength(1);
  await discardProposal(proposal.id);
  const next = await proposalFor(f); await acceptDocumentPlan(f.novel.id, next.proposal.id);
  await createVersion({ chapterId: f.chapters[0]!.id, content: 'TEST concurrent prose', source: 'user_edit' });
  await expect(undoStoryOption(f.novel.id, next.selectionId)).rejects.toThrow('Work changed');
});
it('TEST selecting pauses queued writing; author edits mark adopted direction for review', async () => {
  const f = await fixture(), batch = await generated(f);
  const job = await createJob({ novelId: f.novel.id, type: 'generate_novel', providerId: null, params: {}, steps: [{ kind: 'write_chapter', chapterId: f.chapters[0]!.id, input: {} }] });
  await selectStoryOption(f.owner, batch.id, batch.optionIds[0]!);
  expect((await getJob(job.id))?.status).toBe('paused');
  const p = (await listDocumentPlans(f.novel.id))[0]!; await acceptDocumentPlan(f.novel.id, p.id);
  const card = (await listWritingCards(f.novel.id)).find(c => c.id === f.scene)!;
  await saveWritingCard(f.novel.id, card, { id: card.id, chapterId: card.chapterId, confirmed: true });
  expect(await storyDirectionContext(f.novel.id)).toContain('"state":"review"');
});
it('TEST upgrades the complete legacy wizard draft; binds selected direction atomically without an empty work', async () => {
  const legacy = { version: 1, title: 'TEST wizard', premise: 'TEST framework\nTEST original line', target: 3000, requirements: { ...defaultRequirements(), docType: 'short-story' }, presetId: '', step: 2, providerIds: {}, edited: ['tone'], suggestedSource: 'TEST source', suggestionReason: 'TEST reason' };
  const upgraded = upgradeWizardDraft(legacy); expect(upgraded.premise).toBe(legacy.premise); expect(upgraded.requirements).toEqual(legacy.requirements); expect(upgraded.version).toBe(2);
  await setSetting(WIZARD_DRAFT_KEY, upgraded);
  const draft = { title: legacy.title, premise: legacy.premise, targetChars: legacy.target, requirements: legacy.requirements, styleProfile: null }, owner = { draftId: upgraded.draftId }, scope = { kind: 'work' as const, id: upgraded.draftId };
  const batchId = await generateStoryOptions({ owner, scope, draft, requestKey: 'TEST wizard' });
  const { batch } = await optionBatch(owner, batchId), id = await selectStoryOption(owner, batchId, batch.optionIds[0]!, draft);
  expect(await db.select('SELECT * FROM novels')).toEqual([]);
  await expect(createNovelFromWizard({ ...draft, premise: 'TEST stale change' }, { draftId: upgraded.draftId, selectionId: id })).rejects.toThrow('inputs changed');
  expect(await db.select('SELECT * FROM novels')).toEqual([]);
  const novel = await createNovelFromWizard(draft, { draftId: upgraded.draftId, selectionId: id });
  expect(novel.premise).toBe(legacy.premise); expect(await getSetting(WIZARD_DRAFT_KEY, 'missing')).toBeNull();
  await generateStoryOptionPlan(novel.id, id);
  expect(await listDocumentPlans(novel.id)).toHaveLength(1);
  expect((await optionHistory({ novelId: novel.id }, { kind: 'work', id: novel.id }))[0]?.cards).toHaveLength(4);
  expect(canonicalJson((await optionBatch({ novelId: novel.id }, batchId)).batch.inputSnapshot.draft)).toBe(canonicalJson(draft));
});
it('TEST assistant returns the same cards and stops for author choice; cannot select or auto-adopt', async () => {
  const f = await fixture(), context = AssistantContextSchema.parse({ novelId: f.novel.id }), conversation = await sessionFor(context);
  const run = await createRun('TEST explore', conversation, context, 'TEST explore four options');
  const op = AssistantOperationSchema.parse({ name: 'story_options', parameters: { action: 'generate', scope: { kind: 'work', id: f.novel.id } } });
  const result = await executeOperation(run, op, await revision(f.novel.id), 0, new AbortController().signal);
  expect(result.state).toBe('needs_input'); expect((await getRun(run.id))?.state).toBe('needs_input');
  expect(await db.select('SELECT * FROM story_option_selections')).toEqual([]);
  expect(AssistantOperationSchema.safeParse({ name: 'story_options', parameters: { action: 'select', scope: { kind: 'work', id: f.novel.id } } }).success).toBe(false);
  const batch = (await optionBatch(f.owner, result.objectIds[0]!)).batch;
  const id = await selectStoryOption(f.owner, batch.id, batch.optionIds[0]!);
  const proposal = (await listDocumentPlans(f.novel.id))[0]!;
  const adoptionRun = await createRun('TEST auto adopt', conversation, context, 'TEST continue');
  await expect(executeOperation(adoptionRun, { name: 'candidate', parameters: { id: proposal.id, action: 'accept' } }, await revision(f.novel.id), 0, new AbortController().signal, 'authorized_continuation')).rejects.toThrow('author adoption');
  expect(await db.select('SELECT state FROM story_option_selections WHERE id=?', [id])).toEqual([{ state: 'pending' }]);
});
it('TEST assistant retention is journaled and undoable, preserving candidate history', async () => {
  const f = await fixture(), batch = await generated(f), context = AssistantContextSchema.parse({ novelId: f.novel.id });
  const run = await createRun('TEST retain', await sessionFor(context), context, 'TEST retain the first card');
  const op = AssistantOperationSchema.parse({ name: 'story_options', parameters: { action: 'retain', scope: batch.scope, batchId: batch.id, optionId: batch.optionIds[0], retained: true } });
  await executeOperation(run, op, await revision(f.novel.id), 0, new AbortController().signal);
  expect((await optionBatch(f.owner, batch.id)).batch.keptIds).toEqual([batch.optionIds[0]]);
  expect((await changesFor(`${run.id}:0`)).map(c => c.table_name)).toContain('story_option_batches');
  await undoOperation(`${run.id}:0`, f.novel.id);
  expect((await optionBatch(f.owner, batch.id)).batch.keptIds).toEqual([]);
  expect(await optionCards(batch)).toHaveLength(4);
});
it('TEST exploration history, immutable cards and pending plan survive a real SQLite backup', async () => {
  const f = await fixture(), { batch, proposal } = await proposalFor(f);
  const dir = mkdtempSync(join(tmpdir(), 'TEST-story-options-'));
  try {
    const path = join(dir, 'TEST-backup.db'); await snapshotDatabase(path);
    const restored = createTestDb(path);
    try {
      expect(await restored.select('SELECT json FROM story_option_batches WHERE id=?', [batch.id])).toEqual(await db.select('SELECT json FROM story_option_batches WHERE id=?', [batch.id]));
      expect(await restored.select('SELECT state FROM writing_proposals WHERE id=?', [proposal.id])).toEqual([{ state: 'pending' }]);
      expect(await restored.select('PRAGMA foreign_key_check')).toEqual([]);
    } finally { restored.raw.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('TEST generation rejects title-only mainlines and allows resuming the failed stage', async () => {
  const f = await fixture();
  simulated.reply.mockImplementationOnce(reply).mockImplementationOnce(reply).mockImplementationOnce(async spec => ({ ...await reply(spec), mainline: 'TEST', aftermath: '候选A' }));
  await expect(generated(f)).rejects.toThrow('主线必须');
  const saved = await latestBatch(); expect(saved.optionIds).toEqual([]); expect(saved.state).toBe('failed');
  await resumeStoryOptions(f.owner, saved.id);
  expect((await optionBatch(f.owner, saved.id)).batch.state).toBe('ready');
});
it('TEST new scene order and chapter ownership survive whole-group adoption', async () => {
  const f = await fixture(), scene = (await listWritingCards(f.novel.id)).find(c => c.id === f.scene)!;
  planTransform = p => ({ ...p, cards: [0, 1].map(index => ({ id: null, chapterId: f.chapters[0]!.id, chapterNo: 1, value: { kind: 'scene', data: { ...scene.data, title: `TEST new scene ${index}`, outcome: `TEST outcome ${index}` } } })) });
  const { proposal } = await proposalFor(f, { kind: 'chapter', id: f.chapters[0]!.id });
  await acceptDocumentPlan(f.novel.id, proposal.id);
  const cards = (await listWritingCards(f.novel.id)).filter(c => c.id !== f.scene);
  expect(cards.map(c => c.data)).toMatchObject([{ title: 'TEST new scene 0' }, { title: 'TEST new scene 1' }]);
  expect(cards[0]!.order).toBeLessThan(cards[1]!.order);
  expect(cards.every(c => c.chapterId === f.chapters[0]!.id)).toBe(true);
});
it('TEST independent workbench and prose-assistant requests include adopted scoped constraints', async () => {
  const f = await fixture(), { proposal } = await proposalFor(f); await acceptDocumentPlan(f.novel.id, proposal.id);
  const directions = await storyDirectionContext(f.novel.id);
  simulated.reply.mockResolvedValueOnce({ result: 'TEST SIMULATED' });
  await requestStoryJson(f.novel.id, 'TEST new scene', {}, z.object({ result: z.string() }), new AbortController().signal);
  expect(simulated.reply.mock.calls.at(-1)![0].messages[0].content.split(PLOT_DESIGN_RULE)).toHaveLength(2);
  expect(simulated.reply.mock.calls.at(-1)![0].messages[1].content).toContain(directions);
  const spy = vi.spyOn(completion, 'completeWithRetry').mockResolvedValueOnce({ text: 'TEST SIMULATED discussion', usage: { inputTokens: 10, outputTokens: 10 }, finishReason: 'stop' });
  try {
    await assistantRequest({ novelId: f.novel.id, chapterId: f.chapters[0]!.id, versionId: null, text: '', from: 0, to: 0, operation: 'discuss', instruction: 'TEST discuss', sourceIds: [], signal: new AbortController().signal, onDelta: () => {} });
    expect(spy.mock.calls[0]![1].messages.at(-1)!.content).toContain(directions);
    expect(spy.mock.calls[0]![1].messages[0]!.content.split(PLOT_DESIGN_RULE)).toHaveLength(2);
  } finally { spy.mockRestore(); }
});

it('TEST editorial concerns remain reviewable without critical gaps', async () => {
  const f = await fixture();
  simulated.reply.mockImplementation(async spec => {
    const value = await reply(spec);
    if ('options' in value && spec.messages[1].content.startsWith('统一比较')) value.options.forEach((o: any) => { o.findings = [{ kind: 'editorial', field: 'conflict', quote: 'TEST SIMULATED conflict', authorQuote: '', explanation: 'TEST SIMULATED editorial finding', revision: 'TEST SIMULATED revision' }]; });
    return value;
  });
  const batch = await generated(f);
  await selectStoryOption(f.owner, batch.id, batch.optionIds[1]!);
  expect(await listDocumentPlans(f.novel.id)).toHaveLength(1);
});

it('TEST assistant cannot address a batch through a different scope in the same work', async () => {
  const f = await fixture(), batch = await generated(f), context = AssistantContextSchema.parse({ novelId: f.novel.id });
  const run = await createRun('TEST scope mismatch', await sessionFor(context), context, 'TEST retain scoped card');
  const op = AssistantOperationSchema.parse({ name: 'story_options', parameters: { action: 'retain', scope: { kind: 'chapter', id: f.chapters[0]!.id }, batchId: batch.id, optionId: batch.optionIds[0], retained: true } });
  await expect(executeOperation(run, op, await revision(f.novel.id), 0, new AbortController().signal)).rejects.toThrow('requested scope');
  expect((await optionBatch(f.owner, batch.id)).batch.keptIds).toEqual([]);
});
it('TEST author-note hard-constraint edits mark adopted directions for review', async () => {
  const f = await fixture(), { proposal } = await proposalFor(f); await acceptDocumentPlan(f.novel.id, proposal.id);
  await setSetting(`authorNote:${f.novel.id}`, 'TEST new hard constraint');
  expect(await db.select('SELECT state FROM story_option_decisions')).toEqual([{ state: 'review' }]);
});
it('TEST adopting a replacement supersedes the prior direction and undo restores prior author decisions', async () => {
  const f = await fixture(), first = await proposalFor(f); await acceptDocumentPlan(f.novel.id, first.proposal.id);
  const originalContext = await storyDirectionContext(f.novel.id);
  const next = await proposalFor(f); await acceptDocumentPlan(f.novel.id, next.proposal.id);
  expect(await db.select('SELECT state FROM story_option_decisions WHERE id=?', [first.selectionId])).toEqual([{ state: 'superseded' }]);
  expect(await storyDirectionContext(f.novel.id)).not.toContain(first.batch.optionIds[0]!);
  await undoStoryOption(f.novel.id, next.selectionId);
  expect(await storyDirectionContext(f.novel.id)).toBe(originalContext);
});

it('TEST whole-work cards contain complete outlines, default to restructuring and defer chapters/scenes until adoption', async () => {
  const f = await fixture();
  const originalChapter = await getChapter(f.chapters[0]!.id);
  const originalScene = (await listWritingCards(f.novel.id)).find(c => c.id === f.scene);
  const id = await generateStoryOptions({ owner: f.owner, scope: { kind: 'work', id: f.novel.id }, requestKey: 'TEST outline first' });
  const { batch } = await optionBatch(f.owner, id);
  expect(batch.mode).toBe('restructure');
  expect(batch.inputSnapshot.explorationStage).toBe('outline');
  expect((await optionCards(batch)).every(c => c.outline?.length === 6)).toBe(true);
  expect(await listDocumentPlans(f.novel.id)).toHaveLength(0);
  const selection = await selectStoryOption(f.owner, id, batch.optionIds[0]!);
  const proposal = (await listDocumentPlans(f.novel.id))[0]!;
  expect(proposal.after.chapters).toEqual(proposal.before.chapters);
  expect(proposal.cards ?? []).toHaveLength(0);
  expect(proposal.meta).toMatchObject({ outlineDone: true, tableDone: false, storyOptionStage: 'outline' });
  await acceptDocumentPlan(f.novel.id, proposal.id);
  expect((await getChapter(f.chapters[0]!.id))!.goal).toBe(originalChapter!.goal);
  expect((await listWritingCards(f.novel.id)).find(c => c.id === f.scene)).toEqual(originalScene);
  expect((await getNovel(f.novel.id))!.meta.tableDone).toBe(false);
  expect(await storyDirectionContext(f.novel.id)).toContain('TEST SIMULATED outline');
  await undoStoryOption(f.novel.id, selection);
});
it('TEST incomplete node-only responses cannot masquerade as whole-work outlines', async () => {
  const f = await fixture();
  simulated.reply.mockImplementationOnce(reply).mockImplementationOnce(() => ({ options: Array.from({ length: 4 }, (_, i) => { const { outline, ...node } = content(i); return node; }) }));
  await expect(generateStoryOptions({ owner: f.owner, scope: { kind: 'work', id: f.novel.id }, requestKey: 'TEST missing outline' })).rejects.toThrow();
  expect(await listDocumentPlans(f.novel.id)).toHaveLength(0);
  expect((await latestBatch()).state).toBe('failed');
});
it('TEST outline selection rejects premature scene generation', async () => {
  const f = await fixture(), scene = (await listWritingCards(f.novel.id)).find(c => c.id === f.scene)!;
  planTransform = p => ({ ...p, cards: [{ id: null, chapterId: f.chapters[0]!.id, chapterNo: 1, value: { kind: 'scene', data: scene.data } }] });
  const batch = await generated(f);
  await expect(selectStoryOption(f.owner, batch.id, batch.optionIds[0]!)).rejects.toThrow();
  expect(await listDocumentPlans(f.novel.id)).toHaveLength(0);
});
it('TEST whole-work reconstruction keeps prose untouched while review distinguishes in-scope alternatives from violations', async () => {
  const f = await fixture();
  const prose = await createVersion({ chapterId: f.chapters[0]!.id, content: 'TEST witnessed old opening which may differ from a reconstructed outline', source: 'user_edit' });
  const batch = await generated(f, { kind: 'work', id: f.novel.id }, 'restructure');
  const comparisonRequest = simulated.reply.mock.calls.map(call => call[0]).find(spec => spec.messages[1].content.startsWith('统一比较'));
  expect(comparisonRequest.messages[1].content).toContain('旧作品不是约束');
  expect(comparisonRequest.messages[0].content).toContain('独立故事构思');
  expect(comparisonRequest.messages[1].content).not.toContain(prose.content);
  const selection = await selectStoryOption(f.owner, batch.id, batch.optionIds[0]!);
  const proposal = (await listDocumentPlans(f.novel.id))[0]!;
  await acceptDocumentPlan(f.novel.id, proposal.id);
  expect((await getChapter(f.chapters[0]!.id))!.currentVersionId).toBe(prose.id);
  expect((await getVersion(prose.id))!.content).toBe(prose.content);
  await undoStoryOption(f.novel.id, selection);
});

it('TEST duplicate model entity IDs fail schema validation without creating or altering plans', async () => {
  const f = await fixture(), batch = await generated(f);
  planTransform = p => ({ ...p, after: { ...p.after, arcs: [...p.after.arcs, { ...p.after.arcs[0], title: 'TEST duplicate ID for different arc' }] } });
  await expect(selectStoryOption(f.owner, batch.id, batch.optionIds[0]!)).rejects.toThrow('Duplicate entity IDs');
  expect(await listDocumentPlans(f.novel.id)).toHaveLength(0);
  expect((await getChapter(f.chapters[0]!.id))!.goal).toBe('TEST goal');
});

it('TEST empty whole-work mainline is rejected by model schema before plan creation', async () => {
  const f = await fixture(), batch = await generated(f);
  planTransform = p => ({ ...p, logline: '   ' });
  await expect(selectStoryOption(f.owner, batch.id, batch.optionIds[0]!)).rejects.toThrow();
  expect(await listDocumentPlans(f.novel.id)).toHaveLength(0);
});
