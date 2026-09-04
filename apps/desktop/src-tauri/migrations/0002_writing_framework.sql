-- Writing framework (docs/writing/README.md §7): style profiles, derivative declarations,
-- character voice / lorebook fields, chapter reviews, style feedback, new job/step kinds.

ALTER TABLE novels ADD COLUMN style_profile TEXT;
ALTER TABLE novels ADD COLUMN derivative TEXT;

-- voice = {speechSamples, verbalTics, addressBook, redlines}
ALTER TABLE storyline_characters ADD COLUMN voice TEXT NOT NULL DEFAULT '{}';
-- lore = {triggerKeys, priority, constant}
ALTER TABLE storyline_settings ADD COLUMN lore TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS chapter_reviews (
  id TEXT PRIMARY KEY,
  novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  chapter_version_id TEXT NOT NULL,
  style_score INTEGER NOT NULL DEFAULT 0,
  ooc_count INTEGER NOT NULL DEFAULT 0,
  verdict TEXT NOT NULL DEFAULT 'pass' CHECK (verdict IN ('pass','revise')),
  json TEXT NOT NULL,
  job_step_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_chapter ON chapter_reviews(chapter_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reviews_version ON chapter_reviews(chapter_version_id);

-- Learning layer: phrases the user keeps deleting from AI drafts.
CREATE TABLE IF NOT EXISTS style_feedback (
  novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  phrase TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  promoted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (novel_id, phrase)
);

-- SQLite cannot alter CHECK constraints: rebuild generation_jobs / job_steps with the new kinds.
CREATE TABLE generation_jobs_new (
  id TEXT PRIMARY KEY,
  novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('generate_novel','regenerate_chapter','rewrite','extract_style','style_check')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','pausing','paused','cancelling','cancelled','failed','completed')),
  params TEXT NOT NULL DEFAULT '{}',
  provider_id TEXT,
  progress TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  interrupted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
INSERT INTO generation_jobs_new SELECT id, novel_id, type, status, params, provider_id, progress, error, interrupted, created_at, started_at, updated_at, finished_at FROM generation_jobs;

CREATE TABLE job_steps_new (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES generation_jobs_new(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('outline','chapter_table','write_chapter','adjust_length','summarize','rewrite_chapter','name_replace','style_check','extract_style')),
  chapter_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  input TEXT NOT NULL DEFAULT '{}',
  output_ref TEXT,
  partial_text TEXT,
  error TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  UNIQUE (job_id, seq)
);
INSERT INTO job_steps_new SELECT id, job_id, seq, kind, chapter_id, status, attempts, input, output_ref, partial_text, error, started_at, finished_at FROM job_steps;

DROP TABLE job_steps;
DROP TABLE generation_jobs;
ALTER TABLE generation_jobs_new RENAME TO generation_jobs;
ALTER TABLE job_steps_new RENAME TO job_steps;
CREATE INDEX IF NOT EXISTS idx_jobs_novel ON generation_jobs(novel_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON generation_jobs(status);
