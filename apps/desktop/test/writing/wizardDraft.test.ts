/** TEST fictional draft; real SQLite persistence, no model call. */
import { expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { getSetting, setSetting } from '@/db/repos/settingsRepo';
import { WizardDraftSchema, WIZARD_DRAFT_KEY } from '@/novel/wizardDraft';
import { defaultRequirements } from '@/novel/types';

it('restores a TEST draft with all author inputs and ownership flags; clears after creation', async () => {
  const db = useTestDb();
  try {
    const draft = { version: 1, title: 'TEST 草稿', premise: 'TEST 第一段\n第二段', target: 300000, requirements: { ...defaultRequirements(), mustHave: ['TEST 后手'], style: 'TEST 自定义', tone: '', extra: 'TEST 强反转' }, presetId: 'preset_fast-webnovel', step: 2, providerIds: { planning: 'TEST provider' }, edited: ['style', 'tone', 'presetId'], suggestedSource: 'TEST source', suggestionReason: 'TEST 建议依据' };
    await setSetting(WIZARD_DRAFT_KEY, draft);
    expect(WizardDraftSchema.parse(await getSetting(WIZARD_DRAFT_KEY, null))).toEqual(draft);
    await setSetting(WIZARD_DRAFT_KEY, null);
    expect(await getSetting(WIZARD_DRAFT_KEY, null)).toBeNull();
  } finally { db.raw.close(); }
});
it('rejects incompatible or incomplete drafts instead of fabricating recovered content', () => {
  expect(WizardDraftSchema.safeParse({ version: 99, title: 'TEST' }).success).toBe(false);
  expect(WizardDraftSchema.safeParse({ version: 1, premise: 'TEST', target: 9999999 }).success).toBe(false);
});
