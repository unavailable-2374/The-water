/** REAL model replay on prior fictional cards and fresh generation in an isolated TEST database. */
import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { useTestDb } from '../helpers/testDb';
import { createProvider } from '@/db/repos/providersRepo';
import { setSecretStore } from '@/secrets/keychain';
import { setFetchImpl } from '@/llm/registry';
import { providersForPurposes } from '@/jobs/runner';
import { requestJson } from '@/llm/json';
import { OPTION_COMPARISON_RULE, OPTION_AUDIT_RULE, optionReviewRequest, optionComparisonModelSchema, finalizeOptionComparison, optionQualityBlocked } from '@/novel/storyOptionQuality';
import { generateStoryOptions, resumeStoryOptions } from '@/novel/storyOptions';
import { optionBatch, optionCards } from '@/db/repos/storyOptionsRepo';
import { getSetting, setSetting } from '@/db/repos/settingsRepo';
import type { StoryOption, StoryOptionComparison } from '@the-water/shared';
import type { WizardInput } from '@/novel/service';

it.skipIf(process.env.RUN_REAL_STORY_OPTION_QUALITY !== '1')('REAL replay rejects known core gaps and fresh cards pass event-based review', async () => {
  const deepseek = process.env.REAL_STORY_OPTION_QUALITY_PROVIDER === 'deepseek';
  const key = deepseek ? process.env.DEEPSEEK_API_KEY : process.env.LUNAROUTE_API_KEY;
  if (!key) throw new Error(`${deepseek ? 'DEEPSEEK_API_KEY' : 'LUNAROUTE_API_KEY'} is required`);
  const checkpoint = process.env.REAL_STORY_OPTION_QUALITY_DB;
  if (checkpoint && !checkpoint.includes('/TEST-')) throw new Error('Checkpoint must have a TEST-prefixed filename');
  const db = useTestDb(checkpoint);
  setSecretStore({ get: async () => key, set: async () => undefined, delete: async () => undefined });
  setFetchImpl(fetch);
  const source = JSON.parse(readFileSync(new URL('./fixtures/TEST-story-option-quality-source.json', import.meta.url), 'utf8')) as { authorInput: WizardInput; authorMaterials: string; options: StoryOption[] };
  const sourceFiles = [['storyOptions.ts', '../../src/novel/storyOptions.ts'], ['storyOptionQuality.ts', '../../src/novel/storyOptionQuality.ts'], ['outlineQuality.ts', '../../src/novel/outlineQuality.ts'], ['characterDesign.ts', '../../src/novel/characterDesign.ts'], ['plotDesign.ts', '../../src/novel/plotDesign.ts'], ['shared/storyOptions.ts', '../../../../packages/shared/src/storyOptions.ts']] as const;
  const record: Record<string, unknown> = { label: 'REAL model responses on fictional cards, isolated TEST database. Not objective literary quality measurements.', model: deepseek ? 'deepseek-chat' : 'deepseek-4.1-flash', date: new Date().toISOString(), sourceHashes: Object.fromEntries(sourceFiles.map(([file, path]) => [file, createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex')])) };
  try {
    const provider = await createProvider({ name: 'REAL TEST option quality', kind: 'openai_compatible', ...(deepseek ? { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', contextWindow: 128000, maxOutputTokens: 8192, reasoningTokens: 0, jsonMode: 'json_object' as const } : { baseUrl: 'https://gw.lunaroute.com/v1', model: 'deepseek-4.1-flash', contextWindow: 1048576, maxOutputTokens: 262144, reasoningTokens: 32000, reasoningEffort: 'low' as const, jsonMode: 'json_schema' as const }), temperature: 0.65, extraHeaders: {}, secretRef: 'TEST environment', firstByteTimeoutMs: 120000, idleTimeoutMs: 120000 });
    const { planning } = await providersForPurposes({ params: { providerIds: { planning: provider.id } }, providerId: null }, ['planning']);
    const replayRecord = process.env.REAL_STORY_OPTION_QUALITY_REPLAY_RECORD;
    const prior = await getSetting<StoryOptionComparison | null>('TEST-quality-replay', null) ?? (replayRecord ? JSON.parse(readFileSync(replayRecord, 'utf8')).replay as StoryOptionComparison : null);
    if (replayRecord) record.replayProvenance = replayRecord;
    const assessed = source.options.flatMap(card => {
      const cached = prior?.options.find(o => o.optionId === card.id);
      return cached ? optionComparisonModelSchema([card], source as unknown as Record<string, unknown>, '').parse({ options: [cached], differences: [] }).options : [];
    });
    record.replayReused = !!prior;
    if (prior) expect(assessed).toHaveLength(source.options.length);
    const usage = [];
    for (const card of prior ? [] : source.options) {
      const request = optionReviewRequest([card], source as unknown as Record<string, unknown>, '');
      const review = await requestJson(planning!, { messages: [{ role: 'system', content: OPTION_COMPARISON_RULE + OPTION_AUDIT_RULE + ' 引用只选 eventCitations/summaryCitations/authorCitations 的真实编号：findings 用 citationId、authorCitationId（非作者引用为 none），每条 finding 同时指定所属 checkpoint，qualityAudit 用 evidenceIds、notApplicable；evidenceIds 最多四个完整段落，只能引用 eventCitations 中实际存在的 E 编号，不能自行猜测下一编号，S 开头的说明栏不能证明事件发生，不输出 status/findingIndices。不要自行输出 field/quote；程序还原原文，并根据非 editorial 问题计算 gap 与关联，其他项按适用性计算状态。' }, { role: 'user', content: '独立复审一张卡，differences 为 []，跨卡比较另行执行。\n' + JSON.stringify({ eventCitations: request.citations.filter(c => c.id.startsWith('E')), summaryCitations: request.citations.filter(c => c.id.startsWith('S')), authorCitations: request.authorCitations, input: { authorInput: source.authorInput, authorMaterials: source.authorMaterials }, options: [card] }) }], schema: request.schema, maxTokens: Math.min(24000, provider.maxOutputTokens - (provider.reasoningTokens ?? 0)), temperature: 0.3, label: 'REAL TEST prior-card quality replay' });
      assessed.push(request.decode(review.value).options[0]!); usage.push(review.usage);
      record.replayProgress = assessed;
      if (process.env.REAL_STORY_OPTION_QUALITY_RECORD) writeFileSync(process.env.REAL_STORY_OPTION_QUALITY_RECORD, JSON.stringify(record, null, 2));
    }
    // The replay tests core readiness only; pairwise differences are separately tested in fresh generation.
    const comparisons = assessed.map(o => finalizeOptionComparison({ options: [o], differences: [] }));
    const comparison = { options: comparisons.flatMap(c => c.options), summary: 'REAL replay of prior four fictional cards, individual event audits.' };
    record.replay = comparison;
    record.replayUsage = usage;
    expect(optionQualityBlocked(comparison)).toBe(true);
    expect(comparison.options.every(o => o.qualityAudit?.some(a => a.status === 'gap'))).toBe(true);
    record.replayStatus = 'passed';
    await setSetting('TEST-quality-replay', comparison);
    record.status = 'running';
    if (process.env.REAL_STORY_OPTION_QUALITY_RECORD) writeFileSync(process.env.REAL_STORY_OPTION_QUALITY_RECORD, JSON.stringify(record, null, 2));
    const owner = { draftId: 'TEST-real-option-quality' };
    const pending = await db.select<{ id: string }>('SELECT id FROM story_option_batches ORDER BY rowid DESC LIMIT 1');
    if (pending[0]) await resumeStoryOptions(owner, pending[0].id);
    else await generateStoryOptions({ owner, scope: { kind: 'work', id: owner.draftId }, draft: { ...source.authorInput, styleProfile: null }, authorMaterials: source.authorMaterials, requestKey: 'TEST-real-fresh-quality', providerIds: { planning: provider.id } });
    const rows = await db.select<{ id: string }>('SELECT id FROM story_option_batches ORDER BY rowid DESC LIMIT 1');
    const { batch } = await optionBatch(owner, rows[0]!.id);
    record.freshCards = await optionCards(batch); record.freshComparison = batch.comparison;
    expect(batch.state).toBe('ready');
    expect(batch.comparison && optionQualityBlocked(batch.comparison)).toBe(false);
    record.status = 'passed';
  } catch (e) {
    record.status = 'failed'; record.error = String(e);
    record.rawErrorOutput = e && typeof e === 'object' && 'raw' in e ? e.raw : null;
    record.persistedBatches = await db.select('SELECT json FROM story_option_batches');
    record.persistedCards = await db.select('SELECT json FROM story_options');
    throw e;
  } finally {
    record.usage = await db.select('SELECT model,input_tokens,output_tokens FROM usage_events');
    if (process.env.REAL_STORY_OPTION_QUALITY_RECORD) writeFileSync(process.env.REAL_STORY_OPTION_QUALITY_RECORD, JSON.stringify(record, null, 2));
    db.raw.close();
  }
}, 5400000);
