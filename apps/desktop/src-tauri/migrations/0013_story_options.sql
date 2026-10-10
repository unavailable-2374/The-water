CREATE TABLE story_option_sessions (
  id TEXT PRIMARY KEY,
  novel_id TEXT REFERENCES novels(id) ON DELETE CASCADE,
  draft_id TEXT,
  scope_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (novel_id IS NOT NULL OR draft_id IS NOT NULL)
);
CREATE INDEX story_option_sessions_owner ON story_option_sessions(novel_id, draft_id);
CREATE TABLE story_options (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES story_option_sessions(id) ON DELETE CASCADE,
  json TEXT NOT NULL
);
CREATE TRIGGER story_options_immutable BEFORE UPDATE ON story_options BEGIN
  SELECT RAISE(ABORT, 'Story options are immutable');
END;
CREATE TABLE story_option_batches (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES story_option_sessions(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  UNIQUE(session_id, request_key)
);
CREATE TABLE story_option_selections (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES story_option_batches(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL REFERENCES story_options(id),
  novel_id TEXT REFERENCES novels(id) ON DELETE CASCADE,
  proposal_id TEXT REFERENCES writing_proposals(id) ON DELETE SET NULL,
  state TEXT NOT NULL CHECK(state IN ('selected','planning','failed','pending','accepted','discarded','reverted')),
  error TEXT,
  generated_json TEXT,
  adopted_signature TEXT,
  before_meta TEXT,
  before_title TEXT,
  before_decisions TEXT,
  UNIQUE(batch_id,option_id)
);
CREATE TABLE story_option_decisions (
  id TEXT PRIMARY KEY REFERENCES story_option_selections(id) ON DELETE CASCADE,
  novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  scope_json TEXT NOT NULL,
  option_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','review','superseded','reverted')),
  created_at INTEGER NOT NULL
);
-- Plan edits invalidate adopted directions. Prose edits do not revoke author intent.
CREATE TRIGGER story_direction_novel AFTER UPDATE OF premise,requirements,meta,style_profile,derivative ON novels BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id=NEW.id AND state='active';
END;
CREATE TRIGGER story_direction_author_note_insert AFTER INSERT ON settings WHEN substr(NEW.key,1,11)='authorNote:' BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id=substr(NEW.key,12) AND state='active';
END;
CREATE TRIGGER story_direction_author_note_update AFTER UPDATE ON settings WHEN substr(NEW.key,1,11)='authorNote:' OR substr(OLD.key,1,11)='authorNote:' BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id IN (substr(NEW.key,12),substr(OLD.key,12)) AND state='active';
END;
CREATE TRIGGER story_direction_author_note_delete AFTER DELETE ON settings WHEN substr(OLD.key,1,11)='authorNote:' BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id=substr(OLD.key,12) AND state='active';
END;
CREATE TRIGGER story_direction_cards AFTER UPDATE OF json,confirmed,chapter_id ON writing_cards BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id=NEW.novel_id AND state='active';
END;
CREATE TRIGGER story_direction_chapters AFTER UPDATE OF title,goal,target_chars,pov_character_id,beat_ids,end_hook,archived_at ON chapters BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id=NEW.novel_id AND state='active';
END;
CREATE TRIGGER story_direction_storyline_characters_insert AFTER INSERT ON storyline_characters BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id=NEW.novel_id AND state='active';
END;
CREATE TRIGGER story_direction_storyline_characters_update AFTER UPDATE ON storyline_characters BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id=NEW.novel_id AND state='active';
END;
CREATE TRIGGER story_direction_storyline_characters_delete AFTER DELETE ON storyline_characters BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id=OLD.novel_id AND state='active';
END;
CREATE TRIGGER story_direction_storyline_settings_insert AFTER INSERT ON storyline_settings BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id=NEW.novel_id AND state='active';
END;
CREATE TRIGGER story_direction_storyline_settings_update AFTER UPDATE ON storyline_settings BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id=NEW.novel_id AND state='active';
END;
CREATE TRIGGER story_direction_storyline_settings_delete AFTER DELETE ON storyline_settings BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id=OLD.novel_id AND state='active';
END;
CREATE TRIGGER story_direction_storyline_arcs_insert AFTER INSERT ON storyline_arcs BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id=NEW.novel_id AND state='active';
END;
CREATE TRIGGER story_direction_storyline_arcs_update AFTER UPDATE ON storyline_arcs BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id=NEW.novel_id AND state='active';
END;
CREATE TRIGGER story_direction_storyline_arcs_delete AFTER DELETE ON storyline_arcs BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id=OLD.novel_id AND state='active';
END;
CREATE TRIGGER story_direction_storyline_beats_insert AFTER INSERT ON storyline_beats BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id=NEW.novel_id AND state='active';
END;
CREATE TRIGGER story_direction_storyline_beats_update AFTER UPDATE ON storyline_beats BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id=NEW.novel_id AND state='active';
END;
CREATE TRIGGER story_direction_storyline_beats_delete AFTER DELETE ON storyline_beats BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id=OLD.novel_id AND state='active';
END;
CREATE TRIGGER story_direction_writing_cards_insert AFTER INSERT ON writing_cards BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id=NEW.novel_id AND state='active';
END;
CREATE TRIGGER story_direction_writing_cards_delete AFTER DELETE ON writing_cards BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id=OLD.novel_id AND state='active';
END;
CREATE TRIGGER story_direction_chapters_insert AFTER INSERT ON chapters BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id=NEW.novel_id AND state='active';
END;
CREATE TRIGGER story_direction_chapters_delete AFTER DELETE ON chapters BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id=OLD.novel_id AND state='active';
END;
CREATE TRIGGER story_direction_story_graphs_insert AFTER INSERT ON story_graphs BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id=NEW.novel_id AND state='active';
END;
CREATE TRIGGER story_direction_story_graphs_update AFTER UPDATE ON story_graphs BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id=NEW.novel_id AND state='active';
END;
CREATE TRIGGER story_direction_story_graphs_delete AFTER DELETE ON story_graphs BEGIN
  UPDATE story_option_decisions SET state='review' WHERE novel_id=OLD.novel_id AND state='active';
END;
CREATE TRIGGER story_option_retention_audit AFTER UPDATE ON story_option_batches
WHEN EXISTS(SELECT 1 FROM assistant_mutation_context)
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT (SELECT novel_id FROM story_option_sessions WHERE id=NEW.session_id)) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
  UPDATE assistant_revisions SET revision=revision+1 WHERE novel_id=(SELECT novel_id FROM story_option_sessions WHERE id=NEW.session_id);
  INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
  SELECT operation_id,'story_option_batches',NEW.id,json_object('id',OLD.id,'session_id',OLD.session_id,'request_key',OLD.request_key,'json',OLD.json,'revision',OLD.revision),json_object('id',NEW.id,'session_id',NEW.session_id,'request_key',NEW.request_key,'json',NEW.json,'revision',NEW.revision) FROM assistant_mutation_context WHERE 1
  ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;
