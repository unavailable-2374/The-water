-- Author-owned structure overlays stable scene/beat/chapter IDs. Legacy time stays unspecified.
CREATE TABLE story_graphs (
 novel_id TEXT PRIMARY KEY REFERENCES novels(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE story_changes (
 id TEXT PRIMARY KEY, novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, label TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL,
 card_before TEXT, card_after TEXT, beat_before TEXT, beat_after TEXT, effects_json TEXT NOT NULL DEFAULT '{}', undone INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX idx_story_changes ON story_changes(novel_id,created_at);
CREATE TABLE story_mandates (
 id TEXT PRIMARY KEY, novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
 json TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE story_branches (
 id TEXT PRIMARY KEY, novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
 name TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE story_suggestions (
 id TEXT PRIMARY KEY, novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', json TEXT NOT NULL, created_at INTEGER NOT NULL
);

-- Every editing surface observes author locks, including legacy forms and generated plans.
CREATE TRIGGER locked_writing_card_update BEFORE UPDATE OF json,chapter_id,sort_order,confirmed ON writing_cards
WHEN (NEW.json IS NOT OLD.json OR NEW.chapter_id IS NOT OLD.chapter_id OR NEW.sort_order IS NOT OLD.sort_order OR NEW.confirmed IS NOT OLD.confirmed)
AND EXISTS(SELECT 1 FROM story_graphs g,json_each(g.json,'$.lockedNodeIds') l WHERE g.novel_id=OLD.novel_id AND l.value=OLD.id)
BEGIN SELECT RAISE(ABORT,'Author-locked plan; unlock before editing'); END;
CREATE TRIGGER referenced_writing_card_delete BEFORE DELETE ON writing_cards
WHEN EXISTS(SELECT 1 FROM story_graphs g,json_tree(g.json) r WHERE g.novel_id=OLD.novel_id AND r.type='text' AND r.value=OLD.id)
BEGIN SELECT RAISE(ABORT,'Story graph references this card; remove its links before deleting'); END;
CREATE TRIGGER locked_character_update BEFORE UPDATE ON storyline_characters
WHEN (NEW.name IS NOT OLD.name OR NEW.aliases IS NOT OLD.aliases OR NEW.role IS NOT OLD.role OR NEW.description IS NOT OLD.description OR NEW.arc IS NOT OLD.arc OR NEW.relationships IS NOT OLD.relationships OR NEW.voice IS NOT OLD.voice)
AND EXISTS(SELECT 1 FROM story_graphs g,json_each(g.json,'$.lockedNodeIds') l WHERE g.novel_id=OLD.novel_id AND l.value=OLD.id)
BEGIN SELECT RAISE(ABORT,'Author-locked character; unlock before editing'); END;
CREATE TRIGGER locked_setting_update BEFORE UPDATE ON storyline_settings
WHEN (NEW.name IS NOT OLD.name OR NEW.kind IS NOT OLD.kind OR NEW.description IS NOT OLD.description OR NEW.lore IS NOT OLD.lore)
AND EXISTS(SELECT 1 FROM story_graphs g,json_each(g.json,'$.lockedNodeIds') l WHERE g.novel_id=OLD.novel_id AND l.value=OLD.id)
BEGIN SELECT RAISE(ABORT,'Author-locked setting; unlock before editing'); END;
CREATE TRIGGER locked_arc_update BEFORE UPDATE ON storyline_arcs
WHEN (NEW.title IS NOT OLD.title OR NEW.summary IS NOT OLD.summary OR NEW.start_chapter_no IS NOT OLD.start_chapter_no OR NEW.end_chapter_no IS NOT OLD.end_chapter_no)
AND EXISTS(SELECT 1 FROM story_graphs g,json_each(g.json,'$.lockedNodeIds') l WHERE g.novel_id=OLD.novel_id AND l.value=OLD.id)
BEGIN SELECT RAISE(ABORT,'Author-locked arc; unlock before editing'); END;
CREATE TRIGGER locked_beat_update BEFORE UPDATE ON storyline_beats
WHEN (NEW.title IS NOT OLD.title OR NEW.summary IS NOT OLD.summary OR NEW.arc_id IS NOT OLD.arc_id OR NEW.chapter_no IS NOT OLD.chapter_no OR NEW.character_ids IS NOT OLD.character_ids OR NEW.setting_ids IS NOT OLD.setting_ids OR NEW.sort_order IS NOT OLD.sort_order)
AND EXISTS(SELECT 1 FROM story_graphs g,json_each(g.json,'$.lockedNodeIds') l WHERE g.novel_id=OLD.novel_id AND l.value=OLD.id)
BEGIN SELECT RAISE(ABORT,'Author-locked event; unlock before editing'); END;
CREATE TRIGGER referenced_character_delete BEFORE DELETE ON storyline_characters
WHEN EXISTS(SELECT 1 FROM story_graphs g,json_tree(g.json) r WHERE g.novel_id=OLD.novel_id AND r.type='text' AND r.value=OLD.id)
BEGIN SELECT RAISE(ABORT,'Story graph references this character; remove its links before deleting'); END;
CREATE TRIGGER referenced_setting_delete BEFORE DELETE ON storyline_settings
WHEN EXISTS(SELECT 1 FROM story_graphs g,json_tree(g.json) r WHERE g.novel_id=OLD.novel_id AND r.type='text' AND r.value=OLD.id)
BEGIN SELECT RAISE(ABORT,'Story graph references this setting; remove its links before deleting'); END;
CREATE TRIGGER referenced_arc_delete BEFORE DELETE ON storyline_arcs
WHEN EXISTS(SELECT 1 FROM story_graphs g,json_tree(g.json) r WHERE g.novel_id=OLD.novel_id AND r.type='text' AND r.value=OLD.id)
BEGIN SELECT RAISE(ABORT,'Story graph references this arc; remove its links before deleting'); END;
CREATE TRIGGER referenced_beat_delete BEFORE DELETE ON storyline_beats
WHEN EXISTS(SELECT 1 FROM story_graphs g,json_tree(g.json) r WHERE g.novel_id=OLD.novel_id AND r.type='text' AND r.value=OLD.id)
BEGIN SELECT RAISE(ABORT,'Story graph references this event; remove its links before deleting'); END;
