PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------- settings / providers ----------
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('openai_compatible','anthropic')),
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  context_window INTEGER NOT NULL DEFAULT 128000,
  max_output_tokens INTEGER NOT NULL DEFAULT 8192,
  json_mode TEXT NOT NULL DEFAULT 'none' CHECK (json_mode IN ('none','json_object','json_schema','tool')),
  temperature REAL NOT NULL DEFAULT 0.8,
  extra_headers TEXT NOT NULL DEFAULT '{}',
  secret_ref TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------- reader ----------
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  file_rel_path TEXT NOT NULL,
  file_sha256 TEXT NOT NULL UNIQUE,
  page_count INTEGER NOT NULL DEFAULT 0,
  author TEXT,
  imported_at INTEGER NOT NULL,
  last_opened_at INTEGER,
  last_page INTEGER NOT NULL DEFAULT 1,
  last_zoom REAL NOT NULL DEFAULT 1.0,
  text_indexed INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS document_pages (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_no INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (document_id, page_no)
);

CREATE TABLE IF NOT EXISTS highlights (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_no INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('highlight','note')),
  color TEXT NOT NULL DEFAULT 'yellow',
  anchor TEXT NOT NULL,
  note_text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_highlights_doc_page ON highlights(document_id, page_no);

-- ---------- ai chat ----------
CREATE TABLE IF NOT EXISTS ai_conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('pdf_discuss','novel_assist','scratch')),
  document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  novel_id TEXT,
  chapter_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  provider_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_doc ON ai_conversations(document_id);
CREATE INDEX IF NOT EXISTS idx_conv_novel ON ai_conversations(novel_id);

CREATE TABLE IF NOT EXISTS ai_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('system','user','assistant')),
  content TEXT NOT NULL,
  context TEXT,
  usage TEXT,
  model TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv_seq ON ai_messages(conversation_id, seq);

-- ---------- novels ----------
CREATE TABLE IF NOT EXISTS novels (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  premise TEXT NOT NULL DEFAULT '',
  requirements TEXT NOT NULL DEFAULT '{}',
  target_chars INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','planning','generating','writing','complete')),
  cover_path TEXT,
  origin TEXT,
  remote TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS storyline_characters (
  id TEXT PRIMARY KEY,
  novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  role TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  arc TEXT NOT NULL DEFAULT '',
  relationships TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sl_char_novel ON storyline_characters(novel_id);

CREATE TABLE IF NOT EXISTS storyline_settings (
  id TEXT PRIMARY KEY,
  novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sl_set_novel ON storyline_settings(novel_id);

CREATE TABLE IF NOT EXISTS storyline_arcs (
  id TEXT PRIMARY KEY,
  novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  start_chapter_no INTEGER NOT NULL DEFAULT 1,
  end_chapter_no INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sl_arc_novel ON storyline_arcs(novel_id);

CREATE TABLE IF NOT EXISTS storyline_beats (
  id TEXT PRIMARY KEY,
  novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  arc_id TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  chapter_no INTEGER,
  character_ids TEXT NOT NULL DEFAULT '[]',
  setting_ids TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sl_beat_novel ON storyline_beats(novel_id);

CREATE TABLE IF NOT EXISTS storyline_snapshots (
  id TEXT PRIMARY KEY,
  novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  json TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('generated','user_commit','pre_rewrite','import')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sl_snap_novel ON storyline_snapshots(novel_id, created_at);

CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY,
  novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  chapter_no INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL DEFAULT '',
  target_chars INTEGER NOT NULL DEFAULT 0,
  pov_character_id TEXT,
  beat_ids TEXT NOT NULL DEFAULT '[]',
  end_hook TEXT NOT NULL DEFAULT '',
  current_version_id TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','generating','draft','final','stale')),
  stale_reasons TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  UNIQUE (novel_id, chapter_no)
);

CREATE TABLE IF NOT EXISTS chapter_versions (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  content TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('generated','rewritten','topup','trim','user_edit','imported')),
  storyline_snapshot_id TEXT,
  job_step_id TEXT,
  model TEXT,
  usage TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (chapter_id, version_no)
);
CREATE INDEX IF NOT EXISTS idx_cv_step ON chapter_versions(job_step_id);

CREATE TABLE IF NOT EXISTS story_bible_snapshots (
  id TEXT PRIMARY KEY,
  novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  after_chapter_no INTEGER NOT NULL,
  chapter_version_id TEXT,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bible_novel_ch ON story_bible_snapshots(novel_id, after_chapter_no, created_at);

-- ---------- jobs ----------
CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY,
  novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('generate_novel','regenerate_chapter','rewrite')),
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
CREATE INDEX IF NOT EXISTS idx_jobs_novel ON generation_jobs(novel_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON generation_jobs(status);

CREATE TABLE IF NOT EXISTS job_steps (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('outline','chapter_table','write_chapter','adjust_length','summarize','rewrite_chapter','name_replace')),
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

-- ---------- cloud ----------
CREATE TABLE IF NOT EXISTS sync_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  server_url TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  token_secret_ref TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
