-- current_version_id remains the editor's working pointer for compatibility.
-- Only committed_version_id is published or used as narrative evidence.
ALTER TABLE chapters ADD COLUMN committed_version_id TEXT;
ALTER TABLE chapters ADD COLUMN memory_status TEXT NOT NULL DEFAULT 'missing' CHECK(memory_status IN ('missing','valid','stale','legacy'));
ALTER TABLE chapter_versions ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE chapter_versions ADD COLUMN committed_at INTEGER;
ALTER TABLE chapter_reviews ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE chapter_reviews ADD COLUMN dependency_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE chapter_reviews ADD COLUMN valid INTEGER NOT NULL DEFAULT 0;
ALTER TABLE story_bible_snapshots ADD COLUMN valid INTEGER NOT NULL DEFAULT 0;
-- Never turn an old pending rewrite into accepted canon, or invent a passed review.
UPDATE chapters SET committed_version_id = CASE
 WHEN rewrite_baseline_version_id IS NOT NULL THEN rewrite_baseline_version_id
 WHEN current_version_id IN (SELECT id FROM chapter_versions WHERE state = 'accepted') THEN current_version_id
 ELSE NULL END;
UPDATE chapters SET memory_status = 'legacy' WHERE committed_version_id IS NOT NULL;
UPDATE chapter_versions SET committed_at = created_at, session_id = NULL
 WHERE id IN (SELECT committed_version_id FROM chapters);

CREATE TABLE chapter_commits (
 id TEXT PRIMARY KEY,
 chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
 version_id TEXT NOT NULL REFERENCES chapter_versions(id),
 content_hash TEXT NOT NULL,
 review_id TEXT REFERENCES chapter_reviews(id),
 dependency_hash TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('reviewed','legacy')),
 created_at INTEGER NOT NULL
);
CREATE INDEX idx_commit_version ON chapter_commits(version_id);
INSERT INTO chapter_commits SELECT 'legacy:' || id, id, committed_version_id, '', NULL, '', 'legacy', updated_at
 FROM chapters WHERE committed_version_id IS NOT NULL;
CREATE TRIGGER immutable_committed_content BEFORE UPDATE OF content, content_hash, summary ON chapter_versions
 WHEN OLD.committed_at IS NOT NULL AND (NEW.content <> OLD.content OR NEW.content_hash <> OLD.content_hash OR NEW.summary <> OLD.summary)
 BEGIN SELECT RAISE(ABORT, 'Committed versions are immutable'); END;

CREATE TABLE chapter_extractions (
 id TEXT PRIMARY KEY,
 chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
 version_id TEXT NOT NULL REFERENCES chapter_versions(id) ON DELETE CASCADE,
 content_hash TEXT NOT NULL,
 dependency_hash TEXT NOT NULL,
 review_id TEXT NOT NULL REFERENCES chapter_reviews(id),
 json TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 UNIQUE(version_id, content_hash, dependency_hash, review_id)
);
CREATE TABLE canon_events (
 commit_id TEXT REFERENCES chapter_commits(id),
 id TEXT PRIMARY KEY,
 event_index INTEGER NOT NULL DEFAULT 0,
 novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
 chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
 chapter_no INTEGER NOT NULL,
 version_id TEXT NOT NULL REFERENCES chapter_versions(id),
 content_hash TEXT NOT NULL,
 kind TEXT NOT NULL,
 entity_id TEXT,
 thread_id TEXT,
 from_pos INTEGER NOT NULL,
 to_pos INTEGER NOT NULL,
 quote TEXT NOT NULL,
 json TEXT NOT NULL,
 valid INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL
);
CREATE INDEX idx_canon_retrieval ON canon_events(novel_id, valid, chapter_no, entity_id);
CREATE INDEX idx_canon_commit ON canon_events(commit_id,chapter_no,event_index);
CREATE INDEX idx_canon_thread ON canon_events(novel_id, thread_id, valid);
CREATE TABLE review_resolutions (
 id TEXT PRIMARY KEY,
 review_id TEXT NOT NULL REFERENCES chapter_reviews(id) ON DELETE CASCADE,
 issue_id TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
 created_at INTEGER NOT NULL,
 UNIQUE(review_id, issue_id)
);
CREATE TABLE writing_cards (
 id TEXT PRIMARY KEY,
 novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('brief','volume','scene','thread','character')),
 chapter_id TEXT REFERENCES chapters(id) ON DELETE CASCADE,
 sort_order INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL DEFAULT 1,
 confirmed INTEGER NOT NULL DEFAULT 0,
 json TEXT NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX idx_cards_novel ON writing_cards(novel_id, kind, chapter_id, sort_order);
CREATE TABLE writing_proposals (
 id TEXT PRIMARY KEY,
 novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
 chapter_id TEXT REFERENCES chapters(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('text','plan')),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','discarded','conflict')),
 json TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX idx_proposals_novel ON writing_proposals(novel_id, state);
CREATE TABLE scene_drafts (
 id TEXT PRIMARY KEY,
 chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
 scene_id TEXT NOT NULL REFERENCES writing_cards(id) ON DELETE CASCADE,
 job_step_id TEXT NOT NULL,
 dependency_hash TEXT NOT NULL,
 content TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 UNIQUE(job_step_id, scene_id)
);

CREATE TABLE generation_jobs_new (
  id TEXT PRIMARY KEY,
  novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('generate_novel','regenerate_chapter','rewrite','extract_style','style_check')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','pausing','paused','cancelling','cancelled','failed','completed','awaiting_review')),
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
  kind TEXT NOT NULL CHECK (kind IN ('outline','chapter_table','write_chapter','adjust_length','summarize','rewrite_chapter','name_replace','style_check','extract_style','scene_plan','write_scenes','commit_chapter')),
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

-- Verbatim imported material plus ID correspondence, pending local reconstruction.
CREATE TABLE writing_imports (
 id TEXT PRIMARY KEY, novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
 source_version_id TEXT NOT NULL, source_id TEXT NOT NULL, local_id TEXT NOT NULL,
 json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX idx_writing_imports ON writing_imports(novel_id,local_id);

-- Confirmed planning edits invalidate derived records even outside the workbench UI.
CREATE TRIGGER invalidate_characters_insert AFTER INSERT ON storyline_characters BEGIN
 UPDATE chapters SET memory_status='stale',status=CASE WHEN committed_version_id IS NOT NULL THEN 'stale' ELSE status END WHERE novel_id=NEW.novel_id AND chapter_no>=1;
 UPDATE canon_events SET valid=0 WHERE novel_id=NEW.novel_id AND chapter_no>=1;
 UPDATE story_bible_snapshots SET valid=0 WHERE novel_id=NEW.novel_id AND after_chapter_no>=1;
 UPDATE chapter_reviews SET valid=0 WHERE novel_id=NEW.novel_id AND chapter_id IN (SELECT id FROM chapters WHERE novel_id=NEW.novel_id AND chapter_no>=1);
END;
CREATE TRIGGER invalidate_characters_update AFTER UPDATE ON storyline_characters BEGIN
 UPDATE chapters SET memory_status='stale',status=CASE WHEN committed_version_id IS NOT NULL THEN 'stale' ELSE status END WHERE novel_id=NEW.novel_id AND chapter_no>=1;
 UPDATE canon_events SET valid=0 WHERE novel_id=NEW.novel_id AND chapter_no>=1;
 UPDATE story_bible_snapshots SET valid=0 WHERE novel_id=NEW.novel_id AND after_chapter_no>=1;
 UPDATE chapter_reviews SET valid=0 WHERE novel_id=NEW.novel_id AND chapter_id IN (SELECT id FROM chapters WHERE novel_id=NEW.novel_id AND chapter_no>=1);
END;
CREATE TRIGGER invalidate_characters_delete AFTER DELETE ON storyline_characters BEGIN
 UPDATE chapters SET memory_status='stale',status=CASE WHEN committed_version_id IS NOT NULL THEN 'stale' ELSE status END WHERE novel_id=OLD.novel_id AND chapter_no>=1;
 UPDATE canon_events SET valid=0 WHERE novel_id=OLD.novel_id AND chapter_no>=1;
 UPDATE story_bible_snapshots SET valid=0 WHERE novel_id=OLD.novel_id AND after_chapter_no>=1;
 UPDATE chapter_reviews SET valid=0 WHERE novel_id=OLD.novel_id AND chapter_id IN (SELECT id FROM chapters WHERE novel_id=OLD.novel_id AND chapter_no>=1);
END;
CREATE TRIGGER invalidate_settings_insert AFTER INSERT ON storyline_settings BEGIN
 UPDATE chapters SET memory_status='stale',status=CASE WHEN committed_version_id IS NOT NULL THEN 'stale' ELSE status END WHERE novel_id=NEW.novel_id AND chapter_no>=1;
 UPDATE canon_events SET valid=0 WHERE novel_id=NEW.novel_id AND chapter_no>=1;
 UPDATE story_bible_snapshots SET valid=0 WHERE novel_id=NEW.novel_id AND after_chapter_no>=1;
 UPDATE chapter_reviews SET valid=0 WHERE novel_id=NEW.novel_id AND chapter_id IN (SELECT id FROM chapters WHERE novel_id=NEW.novel_id AND chapter_no>=1);
END;
CREATE TRIGGER invalidate_settings_update AFTER UPDATE ON storyline_settings BEGIN
 UPDATE chapters SET memory_status='stale',status=CASE WHEN committed_version_id IS NOT NULL THEN 'stale' ELSE status END WHERE novel_id=NEW.novel_id AND chapter_no>=1;
 UPDATE canon_events SET valid=0 WHERE novel_id=NEW.novel_id AND chapter_no>=1;
 UPDATE story_bible_snapshots SET valid=0 WHERE novel_id=NEW.novel_id AND after_chapter_no>=1;
 UPDATE chapter_reviews SET valid=0 WHERE novel_id=NEW.novel_id AND chapter_id IN (SELECT id FROM chapters WHERE novel_id=NEW.novel_id AND chapter_no>=1);
END;
CREATE TRIGGER invalidate_settings_delete AFTER DELETE ON storyline_settings BEGIN
 UPDATE chapters SET memory_status='stale',status=CASE WHEN committed_version_id IS NOT NULL THEN 'stale' ELSE status END WHERE novel_id=OLD.novel_id AND chapter_no>=1;
 UPDATE canon_events SET valid=0 WHERE novel_id=OLD.novel_id AND chapter_no>=1;
 UPDATE story_bible_snapshots SET valid=0 WHERE novel_id=OLD.novel_id AND after_chapter_no>=1;
 UPDATE chapter_reviews SET valid=0 WHERE novel_id=OLD.novel_id AND chapter_id IN (SELECT id FROM chapters WHERE novel_id=OLD.novel_id AND chapter_no>=1);
END;
CREATE TRIGGER invalidate_arcs_insert AFTER INSERT ON storyline_arcs BEGIN
 UPDATE chapters SET memory_status='stale',status=CASE WHEN committed_version_id IS NOT NULL THEN 'stale' ELSE status END WHERE novel_id=NEW.novel_id AND chapter_no>=1;
 UPDATE canon_events SET valid=0 WHERE novel_id=NEW.novel_id AND chapter_no>=1;
 UPDATE story_bible_snapshots SET valid=0 WHERE novel_id=NEW.novel_id AND after_chapter_no>=1;
 UPDATE chapter_reviews SET valid=0 WHERE novel_id=NEW.novel_id AND chapter_id IN (SELECT id FROM chapters WHERE novel_id=NEW.novel_id AND chapter_no>=1);
END;
CREATE TRIGGER invalidate_arcs_update AFTER UPDATE ON storyline_arcs BEGIN
 UPDATE chapters SET memory_status='stale',status=CASE WHEN committed_version_id IS NOT NULL THEN 'stale' ELSE status END WHERE novel_id=NEW.novel_id AND chapter_no>=1;
 UPDATE canon_events SET valid=0 WHERE novel_id=NEW.novel_id AND chapter_no>=1;
 UPDATE story_bible_snapshots SET valid=0 WHERE novel_id=NEW.novel_id AND after_chapter_no>=1;
 UPDATE chapter_reviews SET valid=0 WHERE novel_id=NEW.novel_id AND chapter_id IN (SELECT id FROM chapters WHERE novel_id=NEW.novel_id AND chapter_no>=1);
END;
CREATE TRIGGER invalidate_arcs_delete AFTER DELETE ON storyline_arcs BEGIN
 UPDATE chapters SET memory_status='stale',status=CASE WHEN committed_version_id IS NOT NULL THEN 'stale' ELSE status END WHERE novel_id=OLD.novel_id AND chapter_no>=1;
 UPDATE canon_events SET valid=0 WHERE novel_id=OLD.novel_id AND chapter_no>=1;
 UPDATE story_bible_snapshots SET valid=0 WHERE novel_id=OLD.novel_id AND after_chapter_no>=1;
 UPDATE chapter_reviews SET valid=0 WHERE novel_id=OLD.novel_id AND chapter_id IN (SELECT id FROM chapters WHERE novel_id=OLD.novel_id AND chapter_no>=1);
END;
CREATE TRIGGER invalidate_beats_insert AFTER INSERT ON storyline_beats BEGIN
 UPDATE chapters SET memory_status='stale',status=CASE WHEN committed_version_id IS NOT NULL THEN 'stale' ELSE status END WHERE novel_id=NEW.novel_id AND chapter_no>=1;
 UPDATE canon_events SET valid=0 WHERE novel_id=NEW.novel_id AND chapter_no>=1;
 UPDATE story_bible_snapshots SET valid=0 WHERE novel_id=NEW.novel_id AND after_chapter_no>=1;
 UPDATE chapter_reviews SET valid=0 WHERE novel_id=NEW.novel_id AND chapter_id IN (SELECT id FROM chapters WHERE novel_id=NEW.novel_id AND chapter_no>=1);
END;
CREATE TRIGGER invalidate_beats_update AFTER UPDATE ON storyline_beats BEGIN
 UPDATE chapters SET memory_status='stale',status=CASE WHEN committed_version_id IS NOT NULL THEN 'stale' ELSE status END WHERE novel_id=NEW.novel_id AND chapter_no>=1;
 UPDATE canon_events SET valid=0 WHERE novel_id=NEW.novel_id AND chapter_no>=1;
 UPDATE story_bible_snapshots SET valid=0 WHERE novel_id=NEW.novel_id AND after_chapter_no>=1;
 UPDATE chapter_reviews SET valid=0 WHERE novel_id=NEW.novel_id AND chapter_id IN (SELECT id FROM chapters WHERE novel_id=NEW.novel_id AND chapter_no>=1);
END;
CREATE TRIGGER invalidate_beats_delete AFTER DELETE ON storyline_beats BEGIN
 UPDATE chapters SET memory_status='stale',status=CASE WHEN committed_version_id IS NOT NULL THEN 'stale' ELSE status END WHERE novel_id=OLD.novel_id AND chapter_no>=1;
 UPDATE canon_events SET valid=0 WHERE novel_id=OLD.novel_id AND chapter_no>=1;
 UPDATE story_bible_snapshots SET valid=0 WHERE novel_id=OLD.novel_id AND after_chapter_no>=1;
 UPDATE chapter_reviews SET valid=0 WHERE novel_id=OLD.novel_id AND chapter_id IN (SELECT id FROM chapters WHERE novel_id=OLD.novel_id AND chapter_no>=1);
END;
CREATE TRIGGER invalidate_novel_plan AFTER UPDATE OF premise,requirements,style_profile,derivative ON novels
 WHEN NEW.premise IS NOT OLD.premise OR NEW.requirements IS NOT OLD.requirements OR NEW.style_profile IS NOT OLD.style_profile OR NEW.derivative IS NOT OLD.derivative
 BEGIN UPDATE chapters SET memory_status='stale',status=CASE WHEN committed_version_id IS NOT NULL THEN 'stale' ELSE status END WHERE novel_id=NEW.id AND chapter_no>=1;
 UPDATE canon_events SET valid=0 WHERE novel_id=NEW.id AND chapter_no>=1;
 UPDATE story_bible_snapshots SET valid=0 WHERE novel_id=NEW.id AND after_chapter_no>=1;
 UPDATE chapter_reviews SET valid=0 WHERE novel_id=NEW.id AND chapter_id IN (SELECT id FROM chapters WHERE novel_id=NEW.id AND chapter_no>=1); END;
CREATE TRIGGER invalidate_chapter_plan AFTER UPDATE OF chapter_no,title,goal,target_chars,pov_character_id,beat_ids,end_hook ON chapters
 WHEN NEW.chapter_no<>OLD.chapter_no OR NEW.title<>OLD.title OR NEW.goal<>OLD.goal OR NEW.target_chars<>OLD.target_chars OR NEW.pov_character_id IS NOT OLD.pov_character_id OR NEW.beat_ids<>OLD.beat_ids OR NEW.end_hook<>OLD.end_hook
 BEGIN UPDATE chapters SET memory_status='stale',status=CASE WHEN committed_version_id IS NOT NULL THEN 'stale' ELSE status END WHERE novel_id=NEW.novel_id AND chapter_no>=MIN(NEW.chapter_no,OLD.chapter_no);
 UPDATE canon_events SET valid=0 WHERE novel_id=NEW.novel_id AND chapter_no>=MIN(NEW.chapter_no,OLD.chapter_no);
 UPDATE story_bible_snapshots SET valid=0 WHERE novel_id=NEW.novel_id AND after_chapter_no>=MIN(NEW.chapter_no,OLD.chapter_no);
 UPDATE chapter_reviews SET valid=0 WHERE novel_id=NEW.novel_id AND chapter_id IN (SELECT id FROM chapters WHERE novel_id=NEW.novel_id AND chapter_no>=MIN(NEW.chapter_no,OLD.chapter_no)); END;
CREATE TRIGGER invalidate_card_insert AFTER INSERT ON writing_cards WHEN NEW.confirmed=1 BEGIN
 UPDATE chapters SET memory_status='stale',status=CASE WHEN committed_version_id IS NOT NULL THEN 'stale' ELSE status END WHERE novel_id=NEW.novel_id AND chapter_no>=COALESCE((SELECT chapter_no FROM chapters WHERE id=NEW.chapter_id), CASE WHEN NEW.kind='volume' THEN json_extract(NEW.json,'$.data.startChapterNo') ELSE 1 END);
 UPDATE canon_events SET valid=0 WHERE novel_id=NEW.novel_id AND chapter_no>=COALESCE((SELECT chapter_no FROM chapters WHERE id=NEW.chapter_id), CASE WHEN NEW.kind='volume' THEN json_extract(NEW.json,'$.data.startChapterNo') ELSE 1 END);
 UPDATE story_bible_snapshots SET valid=0 WHERE novel_id=NEW.novel_id AND after_chapter_no>=COALESCE((SELECT chapter_no FROM chapters WHERE id=NEW.chapter_id), CASE WHEN NEW.kind='volume' THEN json_extract(NEW.json,'$.data.startChapterNo') ELSE 1 END);
 UPDATE chapter_reviews SET valid=0 WHERE novel_id=NEW.novel_id AND chapter_id IN (SELECT id FROM chapters WHERE novel_id=NEW.novel_id AND chapter_no>=COALESCE((SELECT chapter_no FROM chapters WHERE id=NEW.chapter_id), CASE WHEN NEW.kind='volume' THEN json_extract(NEW.json,'$.data.startChapterNo') ELSE 1 END));
END;
CREATE TRIGGER invalidate_card_update AFTER UPDATE ON writing_cards WHEN (OLD.confirmed=1 OR NEW.confirmed=1) BEGIN
 UPDATE chapters SET memory_status='stale',status=CASE WHEN committed_version_id IS NOT NULL THEN 'stale' ELSE status END WHERE novel_id=NEW.novel_id AND chapter_no>=COALESCE((SELECT chapter_no FROM chapters WHERE id=NEW.chapter_id), CASE WHEN NEW.kind='volume' THEN json_extract(NEW.json,'$.data.startChapterNo') ELSE 1 END);
 UPDATE canon_events SET valid=0 WHERE novel_id=NEW.novel_id AND chapter_no>=COALESCE((SELECT chapter_no FROM chapters WHERE id=NEW.chapter_id), CASE WHEN NEW.kind='volume' THEN json_extract(NEW.json,'$.data.startChapterNo') ELSE 1 END);
 UPDATE story_bible_snapshots SET valid=0 WHERE novel_id=NEW.novel_id AND after_chapter_no>=COALESCE((SELECT chapter_no FROM chapters WHERE id=NEW.chapter_id), CASE WHEN NEW.kind='volume' THEN json_extract(NEW.json,'$.data.startChapterNo') ELSE 1 END);
 UPDATE chapter_reviews SET valid=0 WHERE novel_id=NEW.novel_id AND chapter_id IN (SELECT id FROM chapters WHERE novel_id=NEW.novel_id AND chapter_no>=COALESCE((SELECT chapter_no FROM chapters WHERE id=NEW.chapter_id), CASE WHEN NEW.kind='volume' THEN json_extract(NEW.json,'$.data.startChapterNo') ELSE 1 END));
END;
CREATE TRIGGER invalidate_card_delete AFTER DELETE ON writing_cards WHEN OLD.confirmed=1 BEGIN
 UPDATE chapters SET memory_status='stale',status=CASE WHEN committed_version_id IS NOT NULL THEN 'stale' ELSE status END WHERE novel_id=OLD.novel_id AND chapter_no>=COALESCE((SELECT chapter_no FROM chapters WHERE id=OLD.chapter_id), CASE WHEN OLD.kind='volume' THEN json_extract(OLD.json,'$.data.startChapterNo') ELSE 1 END);
 UPDATE canon_events SET valid=0 WHERE novel_id=OLD.novel_id AND chapter_no>=COALESCE((SELECT chapter_no FROM chapters WHERE id=OLD.chapter_id), CASE WHEN OLD.kind='volume' THEN json_extract(OLD.json,'$.data.startChapterNo') ELSE 1 END);
 UPDATE story_bible_snapshots SET valid=0 WHERE novel_id=OLD.novel_id AND after_chapter_no>=COALESCE((SELECT chapter_no FROM chapters WHERE id=OLD.chapter_id), CASE WHEN OLD.kind='volume' THEN json_extract(OLD.json,'$.data.startChapterNo') ELSE 1 END);
 UPDATE chapter_reviews SET valid=0 WHERE novel_id=OLD.novel_id AND chapter_id IN (SELECT id FROM chapters WHERE novel_id=OLD.novel_id AND chapter_no>=COALESCE((SELECT chapter_no FROM chapters WHERE id=OLD.chapter_id), CASE WHEN OLD.kind='volume' THEN json_extract(OLD.json,'$.data.startChapterNo') ELSE 1 END));
END;

ALTER TABLE llm_providers ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0;

ALTER TABLE chapters ADD COLUMN archived_at INTEGER;
CREATE TABLE chapter_structure_changes (
 id TEXT PRIMARY KEY, novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
 chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('split','merge','reorder')),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applied','cancelled')),
 candidate_version_id TEXT, json TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX one_pending_chapter_structure ON chapter_structure_changes(novel_id) WHERE state='pending';
