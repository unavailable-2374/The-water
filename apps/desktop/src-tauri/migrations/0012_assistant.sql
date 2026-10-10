-- Unified assistant. Existing conversations are intentionally not enrolled or replayed.
CREATE TABLE assistant_sessions (
 conversation_id TEXT PRIMARY KEY REFERENCES ai_conversations(id) ON DELETE CASCADE,
 scope_key TEXT NOT NULL UNIQUE, context_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
);
CREATE TABLE assistant_runs (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES assistant_sessions(conversation_id) ON DELETE CASCADE,
 novel_id TEXT REFERENCES novels(id) ON DELETE SET NULL, message_id TEXT NOT NULL REFERENCES ai_messages(id) ON DELETE CASCADE,
 context_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('running','waiting_job','needs_input','paused','completed','partial','failed','cancelled','undone')),
 goal TEXT NOT NULL DEFAULT '', constraints_json TEXT NOT NULL DEFAULT '[]', job_id TEXT REFERENCES generation_jobs(id) ON DELETE SET NULL,
 error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX assistant_one_active_turn ON assistant_runs(conversation_id) WHERE state IN ('running','waiting_job');
CREATE TABLE assistant_operations (
  complete_after INTEGER NOT NULL DEFAULT 0 CHECK(complete_after IN (0,1)),
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES assistant_runs(id) ON DELETE CASCADE, sequence INTEGER NOT NULL,
 name TEXT NOT NULL, parameters_json TEXT NOT NULL, intent TEXT NOT NULL DEFAULT 'explicit_edit', state TEXT NOT NULL DEFAULT 'running',
 novel_id TEXT REFERENCES novels(id) ON DELETE SET NULL, before_revision INTEGER, after_revision INTEGER,
 result_json TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(run_id,sequence)
);
CREATE TABLE assistant_row_changes (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL REFERENCES assistant_operations(id) ON DELETE CASCADE,
 table_name TEXT NOT NULL, row_id TEXT NOT NULL, before_json TEXT, after_json TEXT,
 UNIQUE(operation_id,table_name,row_id)
);
-- Transaction-local marker: set and cleared in the SAME db.atomic transaction. Never spans awaits.
CREATE TABLE assistant_mutation_context (singleton INTEGER PRIMARY KEY CHECK(singleton=1), operation_id TEXT NOT NULL REFERENCES assistant_operations(id) ON DELETE CASCADE, novel_id TEXT NOT NULL);
CREATE TABLE assistant_revisions (novel_id TEXT PRIMARY KEY REFERENCES novels(id) ON DELETE CASCADE, revision INTEGER NOT NULL DEFAULT 0);
INSERT INTO assistant_revisions(novel_id) SELECT id FROM novels;
ALTER TABLE writing_proposals ADD COLUMN assistant_run_id TEXT REFERENCES assistant_runs(id) ON DELETE SET NULL;
ALTER TABLE writing_proposals ADD COLUMN source_job_id TEXT REFERENCES generation_jobs(id) ON DELETE SET NULL;
CREATE INDEX assistant_proposal_owner ON writing_proposals(assistant_run_id,source_job_id,state);

CREATE TRIGGER assistant_audit_novels_insert AFTER INSERT ON novels
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'novels',NEW.id,NULL,json_object('id',NEW.id,'title',NEW.title,'premise',NEW.premise,'requirements',NEW.requirements,'target_chars',NEW.target_chars,'status',NEW.status,'cover_path',NEW.cover_path,'origin',NEW.origin,'remote',NEW.remote,'meta',NEW.meta,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'style_profile',NEW.style_profile,'derivative',NEW.derivative,'deleted_at',NEW.deleted_at) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_novels_update AFTER UPDATE ON novels WHEN json_object('id',OLD.id,'title',OLD.title,'premise',OLD.premise,'requirements',OLD.requirements,'target_chars',OLD.target_chars,'status',OLD.status,'cover_path',OLD.cover_path,'origin',OLD.origin,'remote',OLD.remote,'meta',OLD.meta,'created_at',OLD.created_at,'updated_at',OLD.updated_at,'style_profile',OLD.style_profile,'derivative',OLD.derivative,'deleted_at',OLD.deleted_at) IS NOT json_object('id',NEW.id,'title',NEW.title,'premise',NEW.premise,'requirements',NEW.requirements,'target_chars',NEW.target_chars,'status',NEW.status,'cover_path',NEW.cover_path,'origin',NEW.origin,'remote',NEW.remote,'meta',NEW.meta,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'style_profile',NEW.style_profile,'derivative',NEW.derivative,'deleted_at',NEW.deleted_at)
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'novels',NEW.id,json_object('id',OLD.id,'title',OLD.title,'premise',OLD.premise,'requirements',OLD.requirements,'target_chars',OLD.target_chars,'status',OLD.status,'cover_path',OLD.cover_path,'origin',OLD.origin,'remote',OLD.remote,'meta',OLD.meta,'created_at',OLD.created_at,'updated_at',OLD.updated_at,'style_profile',OLD.style_profile,'derivative',OLD.derivative,'deleted_at',OLD.deleted_at),json_object('id',NEW.id,'title',NEW.title,'premise',NEW.premise,'requirements',NEW.requirements,'target_chars',NEW.target_chars,'status',NEW.status,'cover_path',NEW.cover_path,'origin',NEW.origin,'remote',NEW.remote,'meta',NEW.meta,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'style_profile',NEW.style_profile,'derivative',NEW.derivative,'deleted_at',NEW.deleted_at) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_novels_delete AFTER DELETE ON novels
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT OLD.id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=OLD.id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT OLD.id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'novels',OLD.id,json_object('id',OLD.id,'title',OLD.title,'premise',OLD.premise,'requirements',OLD.requirements,'target_chars',OLD.target_chars,'status',OLD.status,'cover_path',OLD.cover_path,'origin',OLD.origin,'remote',OLD.remote,'meta',OLD.meta,'created_at',OLD.created_at,'updated_at',OLD.updated_at,'style_profile',OLD.style_profile,'derivative',OLD.derivative,'deleted_at',OLD.deleted_at),NULL FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_storyline_characters_insert AFTER INSERT ON storyline_characters
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'storyline_characters',NEW.id,NULL,json_object('id',NEW.id,'novel_id',NEW.novel_id,'name',NEW.name,'aliases',NEW.aliases,'role',NEW.role,'description',NEW.description,'arc',NEW.arc,'relationships',NEW.relationships,'sort_order',NEW.sort_order,'updated_at',NEW.updated_at,'voice',NEW.voice) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_storyline_characters_update AFTER UPDATE ON storyline_characters WHEN json_object('id',OLD.id,'novel_id',OLD.novel_id,'name',OLD.name,'aliases',OLD.aliases,'role',OLD.role,'description',OLD.description,'arc',OLD.arc,'relationships',OLD.relationships,'sort_order',OLD.sort_order,'updated_at',OLD.updated_at,'voice',OLD.voice) IS NOT json_object('id',NEW.id,'novel_id',NEW.novel_id,'name',NEW.name,'aliases',NEW.aliases,'role',NEW.role,'description',NEW.description,'arc',NEW.arc,'relationships',NEW.relationships,'sort_order',NEW.sort_order,'updated_at',NEW.updated_at,'voice',NEW.voice)
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'storyline_characters',NEW.id,json_object('id',OLD.id,'novel_id',OLD.novel_id,'name',OLD.name,'aliases',OLD.aliases,'role',OLD.role,'description',OLD.description,'arc',OLD.arc,'relationships',OLD.relationships,'sort_order',OLD.sort_order,'updated_at',OLD.updated_at,'voice',OLD.voice),json_object('id',NEW.id,'novel_id',NEW.novel_id,'name',NEW.name,'aliases',NEW.aliases,'role',NEW.role,'description',NEW.description,'arc',NEW.arc,'relationships',NEW.relationships,'sort_order',NEW.sort_order,'updated_at',NEW.updated_at,'voice',NEW.voice) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_storyline_characters_delete AFTER DELETE ON storyline_characters
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT OLD.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=OLD.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT OLD.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'storyline_characters',OLD.id,json_object('id',OLD.id,'novel_id',OLD.novel_id,'name',OLD.name,'aliases',OLD.aliases,'role',OLD.role,'description',OLD.description,'arc',OLD.arc,'relationships',OLD.relationships,'sort_order',OLD.sort_order,'updated_at',OLD.updated_at,'voice',OLD.voice),NULL FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_storyline_settings_insert AFTER INSERT ON storyline_settings
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'storyline_settings',NEW.id,NULL,json_object('id',NEW.id,'novel_id',NEW.novel_id,'name',NEW.name,'kind',NEW.kind,'description',NEW.description,'sort_order',NEW.sort_order,'updated_at',NEW.updated_at,'lore',NEW.lore) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_storyline_settings_update AFTER UPDATE ON storyline_settings WHEN json_object('id',OLD.id,'novel_id',OLD.novel_id,'name',OLD.name,'kind',OLD.kind,'description',OLD.description,'sort_order',OLD.sort_order,'updated_at',OLD.updated_at,'lore',OLD.lore) IS NOT json_object('id',NEW.id,'novel_id',NEW.novel_id,'name',NEW.name,'kind',NEW.kind,'description',NEW.description,'sort_order',NEW.sort_order,'updated_at',NEW.updated_at,'lore',NEW.lore)
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'storyline_settings',NEW.id,json_object('id',OLD.id,'novel_id',OLD.novel_id,'name',OLD.name,'kind',OLD.kind,'description',OLD.description,'sort_order',OLD.sort_order,'updated_at',OLD.updated_at,'lore',OLD.lore),json_object('id',NEW.id,'novel_id',NEW.novel_id,'name',NEW.name,'kind',NEW.kind,'description',NEW.description,'sort_order',NEW.sort_order,'updated_at',NEW.updated_at,'lore',NEW.lore) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_storyline_settings_delete AFTER DELETE ON storyline_settings
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT OLD.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=OLD.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT OLD.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'storyline_settings',OLD.id,json_object('id',OLD.id,'novel_id',OLD.novel_id,'name',OLD.name,'kind',OLD.kind,'description',OLD.description,'sort_order',OLD.sort_order,'updated_at',OLD.updated_at,'lore',OLD.lore),NULL FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_storyline_arcs_insert AFTER INSERT ON storyline_arcs
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'storyline_arcs',NEW.id,NULL,json_object('id',NEW.id,'novel_id',NEW.novel_id,'title',NEW.title,'summary',NEW.summary,'start_chapter_no',NEW.start_chapter_no,'end_chapter_no',NEW.end_chapter_no,'sort_order',NEW.sort_order,'updated_at',NEW.updated_at) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_storyline_arcs_update AFTER UPDATE ON storyline_arcs WHEN json_object('id',OLD.id,'novel_id',OLD.novel_id,'title',OLD.title,'summary',OLD.summary,'start_chapter_no',OLD.start_chapter_no,'end_chapter_no',OLD.end_chapter_no,'sort_order',OLD.sort_order,'updated_at',OLD.updated_at) IS NOT json_object('id',NEW.id,'novel_id',NEW.novel_id,'title',NEW.title,'summary',NEW.summary,'start_chapter_no',NEW.start_chapter_no,'end_chapter_no',NEW.end_chapter_no,'sort_order',NEW.sort_order,'updated_at',NEW.updated_at)
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'storyline_arcs',NEW.id,json_object('id',OLD.id,'novel_id',OLD.novel_id,'title',OLD.title,'summary',OLD.summary,'start_chapter_no',OLD.start_chapter_no,'end_chapter_no',OLD.end_chapter_no,'sort_order',OLD.sort_order,'updated_at',OLD.updated_at),json_object('id',NEW.id,'novel_id',NEW.novel_id,'title',NEW.title,'summary',NEW.summary,'start_chapter_no',NEW.start_chapter_no,'end_chapter_no',NEW.end_chapter_no,'sort_order',NEW.sort_order,'updated_at',NEW.updated_at) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_storyline_arcs_delete AFTER DELETE ON storyline_arcs
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT OLD.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=OLD.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT OLD.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'storyline_arcs',OLD.id,json_object('id',OLD.id,'novel_id',OLD.novel_id,'title',OLD.title,'summary',OLD.summary,'start_chapter_no',OLD.start_chapter_no,'end_chapter_no',OLD.end_chapter_no,'sort_order',OLD.sort_order,'updated_at',OLD.updated_at),NULL FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_storyline_beats_insert AFTER INSERT ON storyline_beats
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'storyline_beats',NEW.id,NULL,json_object('id',NEW.id,'novel_id',NEW.novel_id,'arc_id',NEW.arc_id,'title',NEW.title,'summary',NEW.summary,'chapter_no',NEW.chapter_no,'character_ids',NEW.character_ids,'setting_ids',NEW.setting_ids,'sort_order',NEW.sort_order,'updated_at',NEW.updated_at) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_storyline_beats_update AFTER UPDATE ON storyline_beats WHEN json_object('id',OLD.id,'novel_id',OLD.novel_id,'arc_id',OLD.arc_id,'title',OLD.title,'summary',OLD.summary,'chapter_no',OLD.chapter_no,'character_ids',OLD.character_ids,'setting_ids',OLD.setting_ids,'sort_order',OLD.sort_order,'updated_at',OLD.updated_at) IS NOT json_object('id',NEW.id,'novel_id',NEW.novel_id,'arc_id',NEW.arc_id,'title',NEW.title,'summary',NEW.summary,'chapter_no',NEW.chapter_no,'character_ids',NEW.character_ids,'setting_ids',NEW.setting_ids,'sort_order',NEW.sort_order,'updated_at',NEW.updated_at)
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'storyline_beats',NEW.id,json_object('id',OLD.id,'novel_id',OLD.novel_id,'arc_id',OLD.arc_id,'title',OLD.title,'summary',OLD.summary,'chapter_no',OLD.chapter_no,'character_ids',OLD.character_ids,'setting_ids',OLD.setting_ids,'sort_order',OLD.sort_order,'updated_at',OLD.updated_at),json_object('id',NEW.id,'novel_id',NEW.novel_id,'arc_id',NEW.arc_id,'title',NEW.title,'summary',NEW.summary,'chapter_no',NEW.chapter_no,'character_ids',NEW.character_ids,'setting_ids',NEW.setting_ids,'sort_order',NEW.sort_order,'updated_at',NEW.updated_at) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_storyline_beats_delete AFTER DELETE ON storyline_beats
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT OLD.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=OLD.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT OLD.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'storyline_beats',OLD.id,json_object('id',OLD.id,'novel_id',OLD.novel_id,'arc_id',OLD.arc_id,'title',OLD.title,'summary',OLD.summary,'chapter_no',OLD.chapter_no,'character_ids',OLD.character_ids,'setting_ids',OLD.setting_ids,'sort_order',OLD.sort_order,'updated_at',OLD.updated_at),NULL FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_chapters_insert AFTER INSERT ON chapters
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'chapters',NEW.id,NULL,json_object('id',NEW.id,'novel_id',NEW.novel_id,'chapter_no',NEW.chapter_no,'title',NEW.title,'goal',NEW.goal,'target_chars',NEW.target_chars,'pov_character_id',NEW.pov_character_id,'beat_ids',NEW.beat_ids,'end_hook',NEW.end_hook,'current_version_id',NEW.current_version_id,'status',NEW.status,'stale_reasons',NEW.stale_reasons,'updated_at',NEW.updated_at,'rewrite_baseline_version_id',NEW.rewrite_baseline_version_id,'rewrite_baseline_status',NEW.rewrite_baseline_status,'rewrite_job_id',NEW.rewrite_job_id,'committed_version_id',NEW.committed_version_id,'memory_status',NEW.memory_status,'archived_at',NEW.archived_at) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_chapters_update AFTER UPDATE ON chapters WHEN json_object('id',OLD.id,'novel_id',OLD.novel_id,'chapter_no',OLD.chapter_no,'title',OLD.title,'goal',OLD.goal,'target_chars',OLD.target_chars,'pov_character_id',OLD.pov_character_id,'beat_ids',OLD.beat_ids,'end_hook',OLD.end_hook,'current_version_id',OLD.current_version_id,'status',OLD.status,'stale_reasons',OLD.stale_reasons,'updated_at',OLD.updated_at,'rewrite_baseline_version_id',OLD.rewrite_baseline_version_id,'rewrite_baseline_status',OLD.rewrite_baseline_status,'rewrite_job_id',OLD.rewrite_job_id,'committed_version_id',OLD.committed_version_id,'memory_status',OLD.memory_status,'archived_at',OLD.archived_at) IS NOT json_object('id',NEW.id,'novel_id',NEW.novel_id,'chapter_no',NEW.chapter_no,'title',NEW.title,'goal',NEW.goal,'target_chars',NEW.target_chars,'pov_character_id',NEW.pov_character_id,'beat_ids',NEW.beat_ids,'end_hook',NEW.end_hook,'current_version_id',NEW.current_version_id,'status',NEW.status,'stale_reasons',NEW.stale_reasons,'updated_at',NEW.updated_at,'rewrite_baseline_version_id',NEW.rewrite_baseline_version_id,'rewrite_baseline_status',NEW.rewrite_baseline_status,'rewrite_job_id',NEW.rewrite_job_id,'committed_version_id',NEW.committed_version_id,'memory_status',NEW.memory_status,'archived_at',NEW.archived_at)
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'chapters',NEW.id,json_object('id',OLD.id,'novel_id',OLD.novel_id,'chapter_no',OLD.chapter_no,'title',OLD.title,'goal',OLD.goal,'target_chars',OLD.target_chars,'pov_character_id',OLD.pov_character_id,'beat_ids',OLD.beat_ids,'end_hook',OLD.end_hook,'current_version_id',OLD.current_version_id,'status',OLD.status,'stale_reasons',OLD.stale_reasons,'updated_at',OLD.updated_at,'rewrite_baseline_version_id',OLD.rewrite_baseline_version_id,'rewrite_baseline_status',OLD.rewrite_baseline_status,'rewrite_job_id',OLD.rewrite_job_id,'committed_version_id',OLD.committed_version_id,'memory_status',OLD.memory_status,'archived_at',OLD.archived_at),json_object('id',NEW.id,'novel_id',NEW.novel_id,'chapter_no',NEW.chapter_no,'title',NEW.title,'goal',NEW.goal,'target_chars',NEW.target_chars,'pov_character_id',NEW.pov_character_id,'beat_ids',NEW.beat_ids,'end_hook',NEW.end_hook,'current_version_id',NEW.current_version_id,'status',NEW.status,'stale_reasons',NEW.stale_reasons,'updated_at',NEW.updated_at,'rewrite_baseline_version_id',NEW.rewrite_baseline_version_id,'rewrite_baseline_status',NEW.rewrite_baseline_status,'rewrite_job_id',NEW.rewrite_job_id,'committed_version_id',NEW.committed_version_id,'memory_status',NEW.memory_status,'archived_at',NEW.archived_at) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_chapters_delete AFTER DELETE ON chapters
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT OLD.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=OLD.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT OLD.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'chapters',OLD.id,json_object('id',OLD.id,'novel_id',OLD.novel_id,'chapter_no',OLD.chapter_no,'title',OLD.title,'goal',OLD.goal,'target_chars',OLD.target_chars,'pov_character_id',OLD.pov_character_id,'beat_ids',OLD.beat_ids,'end_hook',OLD.end_hook,'current_version_id',OLD.current_version_id,'status',OLD.status,'stale_reasons',OLD.stale_reasons,'updated_at',OLD.updated_at,'rewrite_baseline_version_id',OLD.rewrite_baseline_version_id,'rewrite_baseline_status',OLD.rewrite_baseline_status,'rewrite_job_id',OLD.rewrite_job_id,'committed_version_id',OLD.committed_version_id,'memory_status',OLD.memory_status,'archived_at',OLD.archived_at),NULL FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_writing_cards_insert AFTER INSERT ON writing_cards
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'writing_cards',NEW.id,NULL,json_object('id',NEW.id,'novel_id',NEW.novel_id,'kind',NEW.kind,'chapter_id',NEW.chapter_id,'sort_order',NEW.sort_order,'revision',NEW.revision,'confirmed',NEW.confirmed,'json',NEW.json,'updated_at',NEW.updated_at) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_writing_cards_update AFTER UPDATE ON writing_cards WHEN json_object('id',OLD.id,'novel_id',OLD.novel_id,'kind',OLD.kind,'chapter_id',OLD.chapter_id,'sort_order',OLD.sort_order,'revision',OLD.revision,'confirmed',OLD.confirmed,'json',OLD.json,'updated_at',OLD.updated_at) IS NOT json_object('id',NEW.id,'novel_id',NEW.novel_id,'kind',NEW.kind,'chapter_id',NEW.chapter_id,'sort_order',NEW.sort_order,'revision',NEW.revision,'confirmed',NEW.confirmed,'json',NEW.json,'updated_at',NEW.updated_at)
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'writing_cards',NEW.id,json_object('id',OLD.id,'novel_id',OLD.novel_id,'kind',OLD.kind,'chapter_id',OLD.chapter_id,'sort_order',OLD.sort_order,'revision',OLD.revision,'confirmed',OLD.confirmed,'json',OLD.json,'updated_at',OLD.updated_at),json_object('id',NEW.id,'novel_id',NEW.novel_id,'kind',NEW.kind,'chapter_id',NEW.chapter_id,'sort_order',NEW.sort_order,'revision',NEW.revision,'confirmed',NEW.confirmed,'json',NEW.json,'updated_at',NEW.updated_at) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_writing_cards_delete AFTER DELETE ON writing_cards
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT OLD.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=OLD.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT OLD.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'writing_cards',OLD.id,json_object('id',OLD.id,'novel_id',OLD.novel_id,'kind',OLD.kind,'chapter_id',OLD.chapter_id,'sort_order',OLD.sort_order,'revision',OLD.revision,'confirmed',OLD.confirmed,'json',OLD.json,'updated_at',OLD.updated_at),NULL FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_story_graphs_insert AFTER INSERT ON story_graphs
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'story_graphs',NEW.novel_id,NULL,json_object('novel_id',NEW.novel_id,'revision',NEW.revision,'json',NEW.json,'updated_at',NEW.updated_at) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_story_graphs_update AFTER UPDATE ON story_graphs WHEN json_object('novel_id',OLD.novel_id,'revision',OLD.revision,'json',OLD.json,'updated_at',OLD.updated_at) IS NOT json_object('novel_id',NEW.novel_id,'revision',NEW.revision,'json',NEW.json,'updated_at',NEW.updated_at)
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'story_graphs',NEW.novel_id,json_object('novel_id',OLD.novel_id,'revision',OLD.revision,'json',OLD.json,'updated_at',OLD.updated_at),json_object('novel_id',NEW.novel_id,'revision',NEW.revision,'json',NEW.json,'updated_at',NEW.updated_at) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_story_graphs_delete AFTER DELETE ON story_graphs
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT OLD.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=OLD.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT OLD.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'story_graphs',OLD.novel_id,json_object('novel_id',OLD.novel_id,'revision',OLD.revision,'json',OLD.json,'updated_at',OLD.updated_at),NULL FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_story_branches_insert AFTER INSERT ON story_branches
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'story_branches',NEW.id,NULL,json_object('id',NEW.id,'novel_id',NEW.novel_id,'name',NEW.name,'revision',NEW.revision,'json',NEW.json,'updated_at',NEW.updated_at) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_story_branches_update AFTER UPDATE ON story_branches WHEN json_object('id',OLD.id,'novel_id',OLD.novel_id,'name',OLD.name,'revision',OLD.revision,'json',OLD.json,'updated_at',OLD.updated_at) IS NOT json_object('id',NEW.id,'novel_id',NEW.novel_id,'name',NEW.name,'revision',NEW.revision,'json',NEW.json,'updated_at',NEW.updated_at)
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'story_branches',NEW.id,json_object('id',OLD.id,'novel_id',OLD.novel_id,'name',OLD.name,'revision',OLD.revision,'json',OLD.json,'updated_at',OLD.updated_at),json_object('id',NEW.id,'novel_id',NEW.novel_id,'name',NEW.name,'revision',NEW.revision,'json',NEW.json,'updated_at',NEW.updated_at) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_story_branches_delete AFTER DELETE ON story_branches
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT OLD.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=OLD.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT OLD.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'story_branches',OLD.id,json_object('id',OLD.id,'novel_id',OLD.novel_id,'name',OLD.name,'revision',OLD.revision,'json',OLD.json,'updated_at',OLD.updated_at),NULL FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_writing_proposals_insert AFTER INSERT ON writing_proposals
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'writing_proposals',NEW.id,NULL,json_object('id',NEW.id,'novel_id',NEW.novel_id,'chapter_id',NEW.chapter_id,'kind',NEW.kind,'state',NEW.state,'json',NEW.json,'created_at',NEW.created_at,'assistant_run_id',NEW.assistant_run_id,'source_job_id',NEW.source_job_id) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_writing_proposals_update AFTER UPDATE ON writing_proposals WHEN json_object('id',OLD.id,'novel_id',OLD.novel_id,'chapter_id',OLD.chapter_id,'kind',OLD.kind,'state',OLD.state,'json',OLD.json,'created_at',OLD.created_at,'assistant_run_id',OLD.assistant_run_id,'source_job_id',OLD.source_job_id) IS NOT json_object('id',NEW.id,'novel_id',NEW.novel_id,'chapter_id',NEW.chapter_id,'kind',NEW.kind,'state',NEW.state,'json',NEW.json,'created_at',NEW.created_at,'assistant_run_id',NEW.assistant_run_id,'source_job_id',NEW.source_job_id)
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'writing_proposals',NEW.id,json_object('id',OLD.id,'novel_id',OLD.novel_id,'chapter_id',OLD.chapter_id,'kind',OLD.kind,'state',OLD.state,'json',OLD.json,'created_at',OLD.created_at,'assistant_run_id',OLD.assistant_run_id,'source_job_id',OLD.source_job_id),json_object('id',NEW.id,'novel_id',NEW.novel_id,'chapter_id',NEW.chapter_id,'kind',NEW.kind,'state',NEW.state,'json',NEW.json,'created_at',NEW.created_at,'assistant_run_id',NEW.assistant_run_id,'source_job_id',NEW.source_job_id) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_writing_proposals_delete AFTER DELETE ON writing_proposals
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT OLD.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=OLD.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT OLD.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'writing_proposals',OLD.id,json_object('id',OLD.id,'novel_id',OLD.novel_id,'chapter_id',OLD.chapter_id,'kind',OLD.kind,'state',OLD.state,'json',OLD.json,'created_at',OLD.created_at,'assistant_run_id',OLD.assistant_run_id,'source_job_id',OLD.source_job_id),NULL FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_chapter_structure_changes_insert AFTER INSERT ON chapter_structure_changes
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'chapter_structure_changes',NEW.id,NULL,json_object('id',NEW.id,'novel_id',NEW.novel_id,'chapter_id',NEW.chapter_id,'kind',NEW.kind,'state',NEW.state,'candidate_version_id',NEW.candidate_version_id,'json',NEW.json,'created_at',NEW.created_at) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_chapter_structure_changes_update AFTER UPDATE ON chapter_structure_changes WHEN json_object('id',OLD.id,'novel_id',OLD.novel_id,'chapter_id',OLD.chapter_id,'kind',OLD.kind,'state',OLD.state,'candidate_version_id',OLD.candidate_version_id,'json',OLD.json,'created_at',OLD.created_at) IS NOT json_object('id',NEW.id,'novel_id',NEW.novel_id,'chapter_id',NEW.chapter_id,'kind',NEW.kind,'state',NEW.state,'candidate_version_id',NEW.candidate_version_id,'json',NEW.json,'created_at',NEW.created_at)
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'chapter_structure_changes',NEW.id,json_object('id',OLD.id,'novel_id',OLD.novel_id,'chapter_id',OLD.chapter_id,'kind',OLD.kind,'state',OLD.state,'candidate_version_id',OLD.candidate_version_id,'json',OLD.json,'created_at',OLD.created_at),json_object('id',NEW.id,'novel_id',NEW.novel_id,'chapter_id',NEW.chapter_id,'kind',NEW.kind,'state',NEW.state,'candidate_version_id',NEW.candidate_version_id,'json',NEW.json,'created_at',NEW.created_at) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_chapter_structure_changes_delete AFTER DELETE ON chapter_structure_changes
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT OLD.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=OLD.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT OLD.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'chapter_structure_changes',OLD.id,json_object('id',OLD.id,'novel_id',OLD.novel_id,'chapter_id',OLD.chapter_id,'kind',OLD.kind,'state',OLD.state,'candidate_version_id',OLD.candidate_version_id,'json',OLD.json,'created_at',OLD.created_at),NULL FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;
-- Session saves may update an existing uncommitted version without changing its chapter pointer.
CREATE TRIGGER assistant_version_revision AFTER UPDATE OF content,content_hash ON chapter_versions
WHEN NEW.content IS NOT OLD.content OR NEW.content_hash IS NOT OLD.content_hash
BEGIN
 UPDATE assistant_revisions SET revision=revision+1 WHERE novel_id=(SELECT novel_id FROM chapters WHERE id=NEW.chapter_id);
END;

CREATE TRIGGER assistant_author_note_insert AFTER INSERT ON settings
WHEN NEW.key LIKE 'authorNote:%' AND EXISTS(SELECT 1 FROM novels WHERE id=substr(NEW.key,12))
BEGIN
 UPDATE assistant_revisions SET revision=revision+1 WHERE novel_id=substr(NEW.key,12);
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT substr(NEW.key,12)) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'settings',NEW.key,NULL,json_object('key',NEW.key,'value',NEW.value) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
 UPDATE chapters SET memory_status='stale' WHERE novel_id=substr(NEW.key,12) AND committed_version_id IS NOT NULL;
 UPDATE chapter_reviews SET valid=0 WHERE novel_id=substr(NEW.key,12);
 UPDATE canon_events SET valid=0 WHERE novel_id=substr(NEW.key,12);
 UPDATE story_bible_snapshots SET valid=0 WHERE novel_id=substr(NEW.key,12);
END;

CREATE TRIGGER assistant_author_note_update AFTER UPDATE ON settings
WHEN NEW.key LIKE 'authorNote:%' AND EXISTS(SELECT 1 FROM novels WHERE id=substr(NEW.key,12))
BEGIN
 UPDATE assistant_revisions SET revision=revision+1 WHERE novel_id=substr(NEW.key,12);
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT substr(NEW.key,12)) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'settings',NEW.key,json_object('key',OLD.key,'value',OLD.value),json_object('key',NEW.key,'value',NEW.value) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
 UPDATE chapters SET memory_status='stale' WHERE novel_id=substr(NEW.key,12) AND committed_version_id IS NOT NULL;
 UPDATE chapter_reviews SET valid=0 WHERE novel_id=substr(NEW.key,12);
 UPDATE canon_events SET valid=0 WHERE novel_id=substr(NEW.key,12);
 UPDATE story_bible_snapshots SET valid=0 WHERE novel_id=substr(NEW.key,12);
END;

CREATE TRIGGER assistant_author_note_delete AFTER DELETE ON settings
WHEN OLD.key LIKE 'authorNote:%' AND EXISTS(SELECT 1 FROM novels WHERE id=substr(OLD.key,12))
BEGIN
 UPDATE assistant_revisions SET revision=revision+1 WHERE novel_id=substr(OLD.key,12);
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT substr(OLD.key,12)) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'settings',OLD.key,json_object('key',OLD.key,'value',OLD.value),NULL FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
 UPDATE chapters SET memory_status='stale' WHERE novel_id=substr(OLD.key,12) AND committed_version_id IS NOT NULL;
 UPDATE chapter_reviews SET valid=0 WHERE novel_id=substr(OLD.key,12);
 UPDATE canon_events SET valid=0 WHERE novel_id=substr(OLD.key,12);
 UPDATE story_bible_snapshots SET valid=0 WHERE novel_id=substr(OLD.key,12);
END;

CREATE TRIGGER assistant_audit_story_suggestions_insert AFTER INSERT ON story_suggestions
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'story_suggestions',NEW.id,NULL,json_object('id',NEW.id,'novel_id',NEW.novel_id,'kind',NEW.kind,'state',NEW.state,'json',NEW.json,'created_at',NEW.created_at) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_story_suggestions_update AFTER UPDATE ON story_suggestions WHEN json_object('id',OLD.id,'novel_id',OLD.novel_id,'kind',OLD.kind,'state',OLD.state,'json',OLD.json,'created_at',OLD.created_at) IS NOT json_object('id',NEW.id,'novel_id',NEW.novel_id,'kind',NEW.kind,'state',NEW.state,'json',NEW.json,'created_at',NEW.created_at)
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'story_suggestions',NEW.id,json_object('id',OLD.id,'novel_id',OLD.novel_id,'kind',OLD.kind,'state',OLD.state,'json',OLD.json,'created_at',OLD.created_at),json_object('id',NEW.id,'novel_id',NEW.novel_id,'kind',NEW.kind,'state',NEW.state,'json',NEW.json,'created_at',NEW.created_at) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_story_suggestions_delete AFTER DELETE ON story_suggestions
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT OLD.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=OLD.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT OLD.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'story_suggestions',OLD.id,json_object('id',OLD.id,'novel_id',OLD.novel_id,'kind',OLD.kind,'state',OLD.state,'json',OLD.json,'created_at',OLD.created_at),NULL FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_story_changes_insert AFTER INSERT ON story_changes
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'story_changes',NEW.id,NULL,json_object('id',NEW.id,'novel_id',NEW.novel_id,'revision',NEW.revision,'label',NEW.label,'before_json',NEW.before_json,'after_json',NEW.after_json,'card_before',NEW.card_before,'card_after',NEW.card_after,'beat_before',NEW.beat_before,'beat_after',NEW.beat_after,'effects_json',NEW.effects_json,'undone',NEW.undone,'created_at',NEW.created_at) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_story_changes_update AFTER UPDATE ON story_changes WHEN json_object('id',OLD.id,'novel_id',OLD.novel_id,'revision',OLD.revision,'label',OLD.label,'before_json',OLD.before_json,'after_json',OLD.after_json,'card_before',OLD.card_before,'card_after',OLD.card_after,'beat_before',OLD.beat_before,'beat_after',OLD.beat_after,'effects_json',OLD.effects_json,'undone',OLD.undone,'created_at',OLD.created_at) IS NOT json_object('id',NEW.id,'novel_id',NEW.novel_id,'revision',NEW.revision,'label',NEW.label,'before_json',NEW.before_json,'after_json',NEW.after_json,'card_before',NEW.card_before,'card_after',NEW.card_after,'beat_before',NEW.beat_before,'beat_after',NEW.beat_after,'effects_json',NEW.effects_json,'undone',NEW.undone,'created_at',NEW.created_at)
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT NEW.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=NEW.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT NEW.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'story_changes',NEW.id,json_object('id',OLD.id,'novel_id',OLD.novel_id,'revision',OLD.revision,'label',OLD.label,'before_json',OLD.before_json,'after_json',OLD.after_json,'card_before',OLD.card_before,'card_after',OLD.card_after,'beat_before',OLD.beat_before,'beat_after',OLD.beat_after,'effects_json',OLD.effects_json,'undone',OLD.undone,'created_at',OLD.created_at),json_object('id',NEW.id,'novel_id',NEW.novel_id,'revision',NEW.revision,'label',NEW.label,'before_json',NEW.before_json,'after_json',NEW.after_json,'card_before',NEW.card_before,'card_after',NEW.card_after,'beat_before',NEW.beat_before,'beat_after',NEW.beat_after,'effects_json',NEW.effects_json,'undone',NEW.undone,'created_at',NEW.created_at) FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;

CREATE TRIGGER assistant_audit_story_changes_delete AFTER DELETE ON story_changes
BEGIN
 INSERT INTO assistant_revisions(novel_id,revision) SELECT OLD.novel_id,1 WHERE EXISTS(SELECT 1 FROM novels WHERE id=OLD.novel_id)
 ON CONFLICT(novel_id) DO UPDATE SET revision=revision+1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_mutation_context WHERE novel_id IS NOT OLD.novel_id) THEN RAISE(ABORT,'Assistant operation crossed work boundary') END;
 INSERT INTO assistant_row_changes(operation_id,table_name,row_id,before_json,after_json)
 SELECT operation_id,'story_changes',OLD.id,json_object('id',OLD.id,'novel_id',OLD.novel_id,'revision',OLD.revision,'label',OLD.label,'before_json',OLD.before_json,'after_json',OLD.after_json,'card_before',OLD.card_before,'card_after',OLD.card_after,'beat_before',OLD.beat_before,'beat_after',OLD.beat_after,'effects_json',OLD.effects_json,'undone',OLD.undone,'created_at',OLD.created_at),NULL FROM assistant_mutation_context WHERE 1
 ON CONFLICT(operation_id,table_name,row_id) DO UPDATE SET after_json=excluded.after_json;
END;
