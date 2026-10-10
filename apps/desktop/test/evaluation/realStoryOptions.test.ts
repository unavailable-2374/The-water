/** REAL model calls on a clearly labeled TEST fictional framework; never production author data. */
import { expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { useTestDb } from '../helpers/testDb';
import { createProvider } from '@/db/repos/providersRepo';
import { setSecretStore } from '@/secrets/keychain';
import { setFetchImpl } from '@/llm/registry';
import { defaultRequirements } from '@/novel/types';
import { generateStoryOptions, selectStoryOption, generateStoryOptionPlan } from '@/novel/storyOptions';
import { optionBatch, optionCards, storyDirectionContext } from '@/db/repos/storyOptionsRepo';
import { createNovel } from '@/db/repos/novelsRepo';
import { upsertChapterPlan, createVersion, getVersion } from '@/db/repos/chaptersRepo';
import { createNovelFromWizard } from '@/novel/service';
import { acceptDocumentPlan, type DocumentPlanProposal } from '@/db/repos/planProposalsRepo';
import { getSetting, setSetting } from '@/db/repos/settingsRepo';
import { recoverStoryOptions } from '@/db/repos/storyOptionsRepo';

it.skipIf(process.env.RUN_REAL_STORY_OPTIONS !== '1')('REAL story options, comparison and selected outline from TEST fiction', async () => {
  const key = process.env.LUNAROUTE_API_KEY;
  if (!key) throw new Error('LUNAROUTE_API_KEY is required');
  const checkpoint = process.env.REAL_STORY_OPTIONS_DB;
  if (checkpoint && !checkpoint.includes('/TEST-')) throw new Error('Checkpoint must have a TEST-prefixed filename');
  const restored = !!checkpoint && existsSync(checkpoint);
  const db = useTestDb(restored ? checkpoint : undefined);
  setSecretStore({ get: async () => key, set: async () => undefined, delete: async () => undefined });
  setFetchImpl(fetch);
  const record: Record<string, unknown> = { label: 'REAL model responses; TEST fictional framework. Editorial judgments are not objective quality scores.', date: new Date().toISOString() };
  try {
    await recoverStoryOptions();
    const savedProvider = await getSetting<string | null>('TEST-real-provider', null);
    const provider = savedProvider ? { id: savedProvider } : await createProvider({ name: 'REAL TEST story options', kind: 'openai_compatible', baseUrl: 'https://gw.lunaroute.com/v1', model: 'deepseek-4.1-flash', contextWindow: 1048576, maxOutputTokens: 262144, reasoningTokens: 32000, reasoningEffort: 'low', jsonMode: 'json_schema', temperature: 0.65, extraHeaders: {}, secretRef: 'TEST environment', firstByteTimeoutMs: 120000, idleTimeoutMs: 120000 });
    await setSetting('TEST-real-provider', provider.id);
    const draft = { title: 'TEST 回声邮局', premise: 'TEST 虚构框架：海岛邮递员林舟在停航前收到一封十年前寄出的求救信。寄信人是仍然健在、拒绝谈起往事的母亲。全篇只发生在离岛前的一个夜晚。没有时间旅行、鬼魂或超自然解释。母亲不能死亡，结局必须由林舟付出具体代价的主动选择推动。作者尚未决定信件迟到的原因或母女矛盾的解法。', requirements: { ...defaultRequirements(), docType: 'short-story', mustHave: ['母亲健在', '主角主动选择并付出具体代价'], taboos: ['超自然解释', '时间旅行', '用母亲死亡解决冲突'] }, targetChars: 3000, styleProfile: null };
    const owner = { draftId: 'TEST-real-story-options' }, scope = { kind: 'work' as const, id: owner.draftId }, providerIds = { planning: provider.id };
    const reconstructionNovel = process.env.REAL_STORY_OPTIONS_RECONSTRUCT === '1' ? await createNovel(draft) : null;
    const reconstructionChapter = reconstructionNovel ? await upsertChapterPlan(reconstructionNovel.id, { chapterNo: 1, title: 'TEST original opening', goal: 'TEST depart from island', targetChars: 3000, povCharacterId: null, beatIds: [], endHook: 'TEST departure' }) : null;
    const originalProse = reconstructionChapter ? await createVersion({ chapterId: reconstructionChapter.id, content: 'TEST 原正文：林舟在离岛前夜决定绝不留下，登上末班船，离开海岛。', source: 'user_edit' }) : null;
    const sourceOwner = reconstructionNovel ? { novelId: reconstructionNovel.id } : owner;
    const sourceScope = reconstructionNovel ? { kind: 'work' as const, id: reconstructionNovel.id } : scope;
    record.originalProse = originalProse;
    const savedWork = await getSetting<{ novelId: string; selection: string; batchId: string } | null>('TEST-real-work', null);
    const id = savedWork?.batchId ?? await generateStoryOptions({ owner: sourceOwner, scope: sourceScope, draft: reconstructionNovel ? undefined : draft, providerIds, mode: 'restructure', feedback: reconstructionNovel ? 'TEST 全书重新构思，至少两个大纲让林舟主动留下，不把旧正文已登船当作不可更改事实。' : '', requestKey: 'TEST real first round' });
    const { batch } = await optionBatch(savedWork ? { novelId: savedWork.novelId } : sourceOwner, id), cards = await optionCards(batch);
    record.input = draft; record.cards = cards; record.comparison = batch.comparison;
    expect(cards).toHaveLength(4); expect(new Set(cards.map(c => c.mainline)).size).toBe(4);
    if (!savedWork) expect(cards.every(c => (c.outline?.length ?? 0) >= 4)).toBe(true);
    expect(batch.comparison?.options.map(c => c.optionId).sort()).toEqual(cards.map(c => c.id).sort());
    // Deterministic TEST author action: selects the first eligible card, never an assistant decision.
    const chosen = cards.find(c => (!reconstructionNovel || /留下|留在|撕.*票/.test(c.ending)) && batch.comparison?.options.some(r => r.optionId === c.id && !r.violations.length && !r.requiresWiderScope));
    if (!chosen) throw new Error('No constraint-valid direction returned by real model');
    const selection = savedWork?.selection ?? await selectStoryOption(sourceOwner, id, chosen.id, reconstructionNovel ? undefined : draft);
    record.selectedByTestAuthor = chosen.id;
    const novel = savedWork ? { id: savedWork.novelId } : reconstructionNovel ?? await createNovelFromWizard(draft, { draftId: owner.draftId, selectionId: selection, providerIds });
    await setSetting('TEST-real-work', { novelId: novel.id, selection, batchId: id });
    await generateStoryOptionPlan(novel.id, selection);
    const rows = await db.select<{ json: string }>('SELECT p.json FROM writing_proposals p JOIN story_option_selections s ON s.proposal_id=p.id WHERE s.id=?', [selection]);
    if (!rows[0]) throw new Error('Selected direction has no saved plan proposal');
    const proposal = JSON.parse(rows[0].json) as DocumentPlanProposal;
    expect(proposal.after.premise).toBe(draft.premise);
    if (batch.inputSnapshot.explorationStage === 'outline') {
      expect(proposal.after.chapters).toEqual(proposal.before.chapters);
      expect(proposal.cards ?? []).toHaveLength(0);
      expect(proposal.meta.tableDone).toBe(false);
    }
    record.plan = proposal;
    await acceptDocumentPlan(novel.id, proposal.id);
    expect(await storyDirectionContext(novel.id)).toContain(chosen.mainline);
    if (originalProse) expect((await getVersion(originalProse.id))!.content).toBe(originalProse.content);
    record.status = 'passed';
  } catch (e) { record.status = 'failed'; record.error = String(e); throw e; }
  finally {
    record.usage = await db.select('SELECT purpose,model,input_tokens,output_tokens FROM usage_events');
    record.selections = await db.select('SELECT option_id,state,error,generated_json FROM story_option_selections');
    if (process.env.REAL_STORY_OPTIONS_RECORD) writeFileSync(process.env.REAL_STORY_OPTIONS_RECORD, JSON.stringify(record, null, 2));
    if (checkpoint) {
      const selection = await db.select<{ novelId: string; selection: string; batchId: string }>('SELECT novel_id AS novelId,id AS selection,batch_id AS batchId FROM story_option_selections WHERE novel_id IS NOT NULL ORDER BY rowid DESC LIMIT 1');
      if (selection[0]) await setSetting('TEST-real-work', selection[0]);
      if (!restored) await db.execute('VACUUM INTO ?', [checkpoint]);
    }
    db.raw.close();
  }
}, 600000);
