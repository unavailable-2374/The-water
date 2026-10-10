/** TEST / SIMULATED legacy SQLite fixtures; never real author data. */
import { it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AssistantOperationSchema, assistantParameters } from '@the-water/shared';
import { catalog } from '@/assistant/catalog';
import { assistant as zh } from '@/i18n/zh/assistant';
import { assistant as en } from '@/i18n/en/assistant';

it('TEST v11 upgrades without enrolling or replaying old conversations', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const dir = fileURLToPath(new URL('../../src-tauri/migrations/', import.meta.url));
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith('.sql') && f < '0012')
      .sort())
      db.exec(readFileSync(dir + file, 'utf8'));
    db.prepare(
      "INSERT INTO novels(id,title,premise,requirements,target_chars,status,created_at,updated_at) VALUES ('TEST-old-work','TEST old','TEST','{}',800,'draft',1,1)",
    ).run();
    db.prepare(
      "INSERT INTO ai_conversations(id,kind,novel_id,title,created_at,updated_at) VALUES ('TEST-old-chat','novel_assist','TEST-old-work','TEST old chat',1,1)",
    ).run();
    db.prepare(
      "INSERT INTO ai_messages(id,conversation_id,seq,role,content,created_at) VALUES ('TEST-old-message','TEST-old-chat',1,'user','TEST historical mutation must not replay',1)",
    ).run();
    const before = db.prepare('SELECT * FROM ai_messages').all();
    db.exec(readFileSync(dir + '0012_assistant.sql', 'utf8'));
    expect(db.prepare('SELECT * FROM ai_messages').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM assistant_sessions').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM assistant_runs').all()).toEqual([]);
    expect(
      db.prepare("SELECT revision FROM assistant_revisions WHERE novel_id='TEST-old-work'").get(),
    ).toEqual({ revision: 0 });
    db.prepare("UPDATE novels SET title='TEST manual update' WHERE id='TEST-old-work'").run();
    expect(
      db.prepare("SELECT revision FROM assistant_revisions WHERE novel_id='TEST-old-work'").get(),
    ).toEqual({ revision: 1 });
    expect(db.prepare('SELECT * FROM assistant_row_changes').all()).toEqual([]);
  } finally {
    db.close();
  }
});
it('TEST every registered capability has a schema and bilingual result label', () => {
  const names = Object.keys(assistantParameters).sort();
  expect(catalog.map((c) => c.name).sort()).toEqual(names);
  expect(AssistantOperationSchema.options.map((o) => o.shape.name.value).sort()).toEqual(names);
  expect(Object.keys(zh.operation).sort()).toEqual(names);
  expect(Object.keys(en.operation).sort()).toEqual(names);
});
