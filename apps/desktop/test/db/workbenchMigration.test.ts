/** TEST populated legacy database: accepted prose, pending rewrite, running task and old summaries. */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('TEST V8 → current migration', () => {
  it('preserves legacy prose, pending candidates and jobs without inventing review passes', () => {
    const dir = fileURLToPath(new URL('../../src-tauri/migrations/', import.meta.url));
    const db = new DatabaseSync(':memory:');
    for (const f of readdirSync(dir)
      .filter((f) => f.endsWith('.sql') && Number(f.split('_')[0]) <= 8)
      .sort())
      db.exec(readFileSync(dir + f, 'utf8'));
    db.exec(`INSERT INTO novels(id,title,created_at,updated_at) VALUES ('TEST-n','TEST legacy',1,1);
      INSERT INTO chapters(id,novel_id,chapter_no,title,status,updated_at,current_version_id,rewrite_baseline_version_id) VALUES ('TEST-c','TEST-n',1,'TEST chapter','draft',1,'TEST-candidate','TEST-official');
      INSERT INTO chapter_versions(id,chapter_id,version_no,content,char_count,source,created_at,state) VALUES ('TEST-official','TEST-c',1,'TEST original prose',19,'generated',1,'accepted'),('TEST-candidate','TEST-c',2,'TEST pending prose',18,'rewritten',2,'pending');
      INSERT INTO story_bible_snapshots(id,novel_id,after_chapter_no,json,created_at) VALUES ('TEST-bible','TEST-n',1,'{"facts":["TEST unverified legacy fact"]}',1);
      INSERT INTO generation_jobs(id,novel_id,type,status,created_at,updated_at) VALUES ('TEST-job','TEST-n','rewrite','running',1,1);
      INSERT INTO job_steps(id,job_id,seq,kind,chapter_id,status,partial_text) VALUES ('TEST-step','TEST-job',0,'rewrite_chapter','TEST-c','running','TEST partial');`);
    db.exec(readFileSync(dir + '0009_writing_workbench.sql', 'utf8'));
    for (const f of readdirSync(dir).filter(f => f.endsWith('.sql') && Number(f.split('_')[0]) > 9).sort()) db.exec(readFileSync(dir + f, 'utf8'));
    expect(db.prepare('SELECT * FROM story_graphs').all()).toEqual([]);
    expect(
      db.prepare('SELECT current_version_id,committed_version_id,memory_status FROM chapters').get(),
    ).toMatchObject({
      current_version_id: 'TEST-candidate',
      committed_version_id: 'TEST-official',
      memory_status: 'legacy',
    });
    expect(db.prepare('SELECT kind,review_id FROM chapter_commits').get()).toMatchObject({
      kind: 'legacy',
      review_id: null,
    });
    expect(db.prepare('SELECT state FROM chapter_versions WHERE id=?').get('TEST-candidate')).toMatchObject({
      state: 'pending',
    });
    expect(db.prepare('SELECT valid FROM story_bible_snapshots').get()).toMatchObject({ valid: 0 });
    expect(db.prepare('SELECT partial_text FROM job_steps').get()).toMatchObject({
      partial_text: 'TEST partial',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(() =>
      db.exec("UPDATE chapter_versions SET content='TEST corrupt' WHERE id='TEST-official'"),
    ).toThrow('immutable');
    db.close();
  });
});
