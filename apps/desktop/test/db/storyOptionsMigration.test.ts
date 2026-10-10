/** TEST populated V12 database and legacy wizard; no real author inputs. */
import { it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { upgradeWizardDraft } from '@/novel/wizardDraft';
import { defaultRequirements } from '@/novel/types';

it('TEST V13 preserves V12 author rows and the full V1 wizard input', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const dir = fileURLToPath(new URL('../../src-tauri/migrations/', import.meta.url));
    for (const file of readdirSync(dir).filter(f => f.endsWith('.sql') && f < '0013').sort()) db.exec(readFileSync(dir + file, 'utf8'));
    const draft = { version: 1, title: 'TEST legacy', premise: 'TEST untouched input\nTEST line two', target: 9000, requirements: defaultRequirements(), presetId: '', step: 2, providerIds: { planning: 'TEST old provider' }, edited: ['tone','audience'], suggestedSource: 'TEST source', suggestionReason: 'TEST reason' };
    db.prepare("INSERT INTO novels(id,title,premise,created_at,updated_at) VALUES ('TEST-novel','TEST title','TEST original framework',1,1)").run();
    db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('studio:createWizardDraft', JSON.stringify(draft));
    const before = db.prepare('SELECT * FROM novels').all();
    db.exec(readFileSync(dir + '0013_story_options.sql', 'utf8'));
    expect(db.prepare('SELECT * FROM novels').all()).toEqual(before);
    const saved = db.prepare("SELECT value FROM settings WHERE key='studio:createWizardDraft'").get() as { value: string };
    expect(JSON.parse(saved.value)).toEqual(draft);
    const upgraded = upgradeWizardDraft(JSON.parse(saved.value));
    expect(upgraded).toMatchObject({ ...draft, version: 2, step: 1 });
    expect(upgraded.draftId).toBeTruthy(); expect(upgraded.storySelectionId).toBeNull();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { db.close(); }
});
