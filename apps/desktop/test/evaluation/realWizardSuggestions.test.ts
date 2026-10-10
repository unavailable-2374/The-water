/** REAL network call; isolated TEST fiction. Not literary quality evidence. */
import { expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { useTestDb } from '../helpers/testDb';
import { createProvider } from '@/db/repos/providersRepo';
import { setSecretStore } from '@/secrets/keychain';
import { setFetchImpl } from '@/llm/registry';
import { suggestWizardRequirements } from '@/novel/suggestWizardRequirements';
import { defaultRequirements } from '@/novel/types';

it.skipIf(process.env.RUN_REAL_WIZARD !== '1')('REAL AI suggests defaults from TEST framework before any novel exists', async () => {
  const key = process.env.LUNAROUTE_API_KEY;
  if (!key) throw new Error('LUNAROUTE_API_KEY is required');
  const db = useTestDb();
  setSecretStore({ get: async () => key, set: async () => undefined, delete: async () => undefined });
  setFetchImpl(fetch);
  const record: Record<string, unknown> = { label: 'REAL AI response; TEST fictional framework' };
  try {
    const provider = await createProvider({ name: 'REAL TEST wizard', kind: 'openai_compatible', baseUrl: 'https://gw.lunaroute.com/v1', model: 'deepseek-4.1-flash', contextWindow: 1048576, maxOutputTokens: 262144, reasoningTokens: 32000, reasoningEffort: 'low', jsonMode: 'json_schema', temperature: 0.3, extraHeaders: {}, secretRef: 'TEST environment', firstByteTimeoutMs: 120000, idleTimeoutMs: 120000 });
    const result = await suggestWizardRequirements({ title: 'TEST 海底来信', premise: 'TEST 虚构框架：深海科研站收到来自三天后的求救信号。工程师用第一人称记录排查过程，以现在时叙述；面向成年读者，冷静克制，无搞笑情节。最后发现信号来自自己的设备。', requirements: { ...defaultRequirements(), docType: 'short-story' }, targetChars: 3000 }, { planning: provider.id }, AbortSignal.timeout(300000));
    record.result = result;
    expect(result.genre).toBe('科幻');
    expect(result.pov).toBe('第一人称');
    expect(result.tense).toContain('现在');
    expect(result.audience).toContain('成年');
    const usage = await db.select<{ purpose: string }>('SELECT purpose FROM usage_events');
    expect(usage).toEqual([{ purpose: 'planning' }]);
    expect(await db.select('SELECT id FROM novels')).toEqual([]);
    record.status = 'passed';
  } catch (error) { record.status = 'failed'; record.error = String(error); throw error; }
  finally { if (process.env.REAL_WIZARD_RECORD) writeFileSync(process.env.REAL_WIZARD_RECORD, JSON.stringify(record, null, 2)); db.raw.close(); }
}, 360000);
