/** Opt-in REAL provider calls using TEST fiction; these checks do not assess literary quality. */
import { expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { useTestDb } from '../helpers/testDb';
import { createProvider } from '@/db/repos/providersRepo';
import { createNovel } from '@/db/repos/novelsRepo';
import { createVersion, getChapter, getVersion, upsertChapterPlan } from '@/db/repos/chaptersRepo';
import { saveWritingCard } from '@/db/repos/writingRepo';
import { getStoryGraph, makeStoryAnchor, saveStoryGraph } from '@/db/repos/storyGraphRepo';
import { createStoryBranch, generateBranchSample } from '@/novel/storyBranches';
import { listStoryReadings, readStoryProse, discussStory, suggestStoryVoice } from '@/novel/storyIntelligence';
import { applyStoryProposal, createMandate, runMandate } from '@/novel/storyMandates';
import { listTextProposals } from '@/novel/assistant';
import { defaultRequirements } from '@/novel/types';
import { setSecretStore } from '@/secrets/keychain';
import { setFetchImpl } from '@/llm/registry';

it.skipIf(process.env.RUN_REAL_STORY_WORKSPACE !== '1')('REAL story workspace operations on isolated TEST fiction', async () => {
  const key = process.env.LUNAROUTE_API_KEY;
  if (!key) throw new Error('LUNAROUTE_API_KEY is required');
  const db = useTestDb();
  const record: Record<string, unknown> = { label: 'REAL provider responses; TEST fictional inputs; not literary quality evidence', startedAt: new Date().toISOString(), stages: {} };
  const stages = record.stages as Record<string, unknown>;
  setSecretStore({ get: async () => key, set: async () => undefined, delete: async () => undefined });
  setFetchImpl(fetch);
  const signal = AbortSignal.timeout(9 * 60 * 1000);
  try {
    await createProvider({ name: 'REAL Lunaroute TEST evaluation', kind: 'openai_compatible', baseUrl: 'https://gw.lunaroute.com/v1', model: 'deepseek-4.1-flash', contextWindow: 1048576, maxOutputTokens: 262144, reasoningTokens: 32000, reasoningEffort: 'low', jsonMode: 'json_schema', temperature: 0.6, extraHeaders: {}, secretRef: 'TEST evaluation environment', firstByteTimeoutMs: 120000, idleTimeoutMs: 120000 });
    const novel = await createNovel({ title: 'TEST 真实 AI 功能验收', premise: 'TEST 虚构故事：林舟发现信件日期有误，选择先核对记录。', requirements: defaultRequirements(), targetChars: 250 });
    const chapter = await upsertChapterPlan(novel.id, { chapterNo: 1, title: 'TEST 日期', targetChars: 250 });
    const text = 'TEST 虚构故事。清晨，林舟在旅馆发现信封上的日期比登记簿早了三天。他把信留在抽屉，拿着登记簿去找顾青核对。顾青指着记录说：“先确认日期，再拆信。”林舟点头，把钥匙收进口袋。';
    const version = await createVersion({ chapterId: chapter.id, content: text, source: 'user_edit' });
    const nodeId = await saveWritingCard(novel.id, { kind: 'scene', data: { title: 'TEST 核对日期', volumeId: null, povCharacterId: null, time: '清晨', location: '旅馆', characterIds: [], goal: '核对日期', obstacle: '信封与登记簿日期不一致', turn: '顾青建议先确认日期', outcome: '林舟暂不拆信', targetChars: 250, dependencyIds: [], threadIds: [] } }, { chapterId: chapter.id, confirmed: true });
    const { graph } = await getStoryGraph(novel.id);
    const anchor = await makeStoryAnchor(nodeId, chapter.id, 0, text.length);
    graph.anchors.push(anchor); graph.preferences.sampleAnchorIds = [anchor.id];
    await saveStoryGraph(novel.id, 0, graph, 'TEST author sample');
    await readStoryProse(novel.id, chapter.id, signal);
    const reading = (await listStoryReadings(novel.id))[0]!;
    expect(reading.reading.scenes.length).toBeGreaterThan(0);
    for (const scene of reading.reading.scenes) expect(text.slice(scene.evidence.from, scene.evidence.to)).toBe(scene.evidence.quote);
    stages.extraction = reading.reading;
    stages.discussion = await discussStory(novel.id, 'TEST 给出两个不同走向；不提前打开信。', signal);
    expect((stages.discussion as { alternatives: unknown[] }).alternatives.length).toBeGreaterThanOrEqual(2);
    stages.voice = await suggestStoryVoice(novel.id, signal);
    expect((stages.voice as { narration: string }).narration.trim()).not.toBe('');
    const branch = await createStoryBranch(novel.id, nodeId, 'TEST alternative');
    const sample = await generateBranchSample(novel.id, branch, 'TEST 写约 150 字：林舟改为先核对邮戳，信仍未打开。', signal);
    expect(sample.sample.trim()).not.toBe('');
    expect((await getChapter(chapter.id))!.currentVersionId).toBe(version.id);
    stages.branch = { sample: sample.sample, facts: sample.facts };
    const mandate = await createMandate(novel.id, [nodeId], { must: 'TEST 核对日期，约 150 字', may: '补充具体动作', mustNot: '不能打开信' });
    await runMandate(novel.id, mandate.id, signal, () => undefined);
    const proposal = (await listTextProposals(chapter.id)).find(p => p.mandateId === mandate.id)!;
    expect(proposal).toBeDefined();
    expect((await getChapter(chapter.id))!.currentVersionId).toBe(version.id);
    await applyStoryProposal(novel.id, chapter.id, proposal.id);
    const accepted = (await getVersion((await getChapter(chapter.id))!.currentVersionId!))!;
    expect(accepted.content.trim()).not.toBe('');
    expect(accepted.committedAt).toBeNull();
    stages.mandate = { candidate: accepted.content, remainsUncommitted: accepted.committedAt === null };
    record.status = 'passed';
  } catch (error) {
    record.status = 'failed'; record.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    record.finishedAt = new Date().toISOString();
    record.usage = await db.select('SELECT purpose,model,provider_kind,input_tokens,output_tokens FROM usage_events');
    const output = process.env.REAL_STORY_WORKSPACE_RECORD;
    if (output) { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(record, null, 2) + '\n'); }
    db.raw.close();
  }
}, 10 * 60 * 1000);
