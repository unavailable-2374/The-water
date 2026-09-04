import { nanoid } from 'nanoid';
import {
  StorylineDocSchema, StyleProfileSchema, DerivativeDeclSchema, type Arc, type Beat, type Character, type Setting, type StorylineDoc, type ChapterPlan,
  type CharacterVoice, type SettingLore, type StyleProfile, type DerivativeDecl, emptyStoryline, emptyVoice, emptyLore,
} from '@the-water/shared';
import { getDb, now, selectOne } from '../db';
import { parseJson, parseJsonLoose } from '../mappers';
import { listChapters } from './chaptersRepo';

export type SnapshotReason = 'generated' | 'user_commit' | 'pre_rewrite' | 'import';
export interface StorylineSnapshot { id: string; novelId: string; doc: StorylineDoc; reason: SnapshotReason; createdAt: number }

interface RawChar { id: string; novel_id: string; name: string; aliases: string; role: string; description: string; arc: string; relationships: string; voice: string; sort_order: number; updated_at: number }
interface RawSet { id: string; novel_id: string; name: string; kind: string; description: string; lore: string; sort_order: number; updated_at: number }
interface RawArc { id: string; novel_id: string; title: string; summary: string; start_chapter_no: number; end_chapter_no: number; sort_order: number; updated_at: number }
interface RawBeat { id: string; novel_id: string; arc_id: string | null; title: string; summary: string; chapter_no: number | null; character_ids: string; setting_ids: string; sort_order: number; updated_at: number }

export async function listCharacters(novelId: string): Promise<Character[]> {
  const rows = await getDb().select<RawChar>('SELECT * FROM storyline_characters WHERE novel_id = ? ORDER BY sort_order, updated_at', [novelId]);
  return rows.map((r) => ({ id: r.id, name: r.name, aliases: parseJsonLoose<string[]>(r.aliases, []), role: r.role, description: r.description, arc: r.arc, relationships: parseJsonLoose(r.relationships, []), ...emptyVoice(), ...parseJsonLoose<Partial<CharacterVoice>>(r.voice, {}) }));
}
export async function listSettings(novelId: string): Promise<Setting[]> {
  const rows = await getDb().select<RawSet>('SELECT * FROM storyline_settings WHERE novel_id = ? ORDER BY sort_order, updated_at', [novelId]);
  return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind as Setting['kind'], description: r.description, ...emptyLore(), ...parseJsonLoose<Partial<SettingLore>>(r.lore, {}) }));
}
export async function listArcs(novelId: string): Promise<Arc[]> {
  const rows = await getDb().select<RawArc>('SELECT * FROM storyline_arcs WHERE novel_id = ? ORDER BY sort_order, start_chapter_no', [novelId]);
  return rows.map((r) => ({ id: r.id, title: r.title, summary: r.summary, startChapterNo: r.start_chapter_no, endChapterNo: r.end_chapter_no }));
}
export async function listBeats(novelId: string): Promise<Beat[]> {
  const rows = await getDb().select<RawBeat>('SELECT * FROM storyline_beats WHERE novel_id = ? ORDER BY sort_order, chapter_no', [novelId]);
  return rows.map((r) => ({ id: r.id, arcId: r.arc_id, title: r.title, summary: r.summary, chapterNo: r.chapter_no, characterIds: parseJsonLoose(r.character_ids, []), settingIds: parseJsonLoose(r.setting_ids, []), order: r.sort_order }));
}

export async function upsertCharacter(novelId: string, c: Partial<Character> & { name: string }, sortOrder?: number): Promise<Character> {
  const id = c.id ?? nanoid();
  const voice: CharacterVoice = { speechSamples: c.speechSamples ?? [], verbalTics: c.verbalTics ?? [], addressBook: c.addressBook ?? {}, redlines: c.redlines ?? [] };
  await getDb().execute(
    `INSERT INTO storyline_characters(id, novel_id, name, aliases, role, description, arc, relationships, voice, sort_order, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, aliases=excluded.aliases, role=excluded.role, description=excluded.description, arc=excluded.arc, relationships=excluded.relationships, voice=excluded.voice, sort_order=excluded.sort_order, updated_at=excluded.updated_at`,
    [id, novelId, c.name, JSON.stringify(c.aliases ?? []), c.role ?? '', c.description ?? '', c.arc ?? '', JSON.stringify(c.relationships ?? []), JSON.stringify(voice), sortOrder ?? 0, now()],
  );
  return { id, name: c.name, aliases: c.aliases ?? [], role: c.role ?? '', description: c.description ?? '', arc: c.arc ?? '', relationships: c.relationships ?? [], ...voice };
}
export async function upsertSetting(novelId: string, s: Partial<Setting> & { name: string }, sortOrder?: number): Promise<Setting> {
  const id = s.id ?? nanoid();
  const lore: SettingLore = { triggerKeys: s.triggerKeys ?? [], priority: s.priority ?? 50, constant: s.constant ?? false };
  await getDb().execute(
    `INSERT INTO storyline_settings(id, novel_id, name, kind, description, lore, sort_order, updated_at) VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, description=excluded.description, lore=excluded.lore, sort_order=excluded.sort_order, updated_at=excluded.updated_at`,
    [id, novelId, s.name, s.kind ?? 'other', s.description ?? '', JSON.stringify(lore), sortOrder ?? 0, now()],
  );
  return { id, name: s.name, kind: s.kind ?? 'other', description: s.description ?? '', ...lore };
}
export async function upsertArc(novelId: string, a: Partial<Arc> & { title: string }, sortOrder?: number): Promise<Arc> {
  const id = a.id ?? nanoid();
  await getDb().execute(
    `INSERT INTO storyline_arcs(id, novel_id, title, summary, start_chapter_no, end_chapter_no, sort_order, updated_at) VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, summary=excluded.summary, start_chapter_no=excluded.start_chapter_no, end_chapter_no=excluded.end_chapter_no, sort_order=excluded.sort_order, updated_at=excluded.updated_at`,
    [id, novelId, a.title, a.summary ?? '', a.startChapterNo ?? 1, a.endChapterNo ?? 1, sortOrder ?? 0, now()],
  );
  return { id, title: a.title, summary: a.summary ?? '', startChapterNo: a.startChapterNo ?? 1, endChapterNo: a.endChapterNo ?? 1 };
}
export async function upsertBeat(novelId: string, b: Partial<Beat> & { title: string }, sortOrder?: number): Promise<Beat> {
  const id = b.id ?? nanoid();
  const order = sortOrder ?? b.order ?? 0;
  await getDb().execute(
    `INSERT INTO storyline_beats(id, novel_id, arc_id, title, summary, chapter_no, character_ids, setting_ids, sort_order, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET arc_id=excluded.arc_id, title=excluded.title, summary=excluded.summary, chapter_no=excluded.chapter_no, character_ids=excluded.character_ids, setting_ids=excluded.setting_ids, sort_order=excluded.sort_order, updated_at=excluded.updated_at`,
    [id, novelId, b.arcId ?? null, b.title, b.summary ?? '', b.chapterNo ?? null, JSON.stringify(b.characterIds ?? []), JSON.stringify(b.settingIds ?? []), order, now()],
  );
  return { id, arcId: b.arcId ?? null, title: b.title, summary: b.summary ?? '', chapterNo: b.chapterNo ?? null, characterIds: b.characterIds ?? [], settingIds: b.settingIds ?? [], order };
}
export async function deleteEntity(table: 'characters' | 'settings' | 'arcs' | 'beats', id: string): Promise<void> {
  await getDb().execute(`DELETE FROM storyline_${table} WHERE id = ?`, [id]);
}

/** Style profile + derivative declaration live on the novel row but belong to the storyline document. */
export async function getStyleExtras(novelId: string): Promise<{ styleProfile: StyleProfile | null; derivative: DerivativeDecl | null }> {
  const r = await selectOne<{ style_profile: string | null; derivative: string | null }>('SELECT style_profile, derivative FROM novels WHERE id = ?', [novelId]);
  return {
    styleProfile: r?.style_profile ? parseJson(StyleProfileSchema, r.style_profile, null as unknown as StyleProfile) : null,
    derivative: r?.derivative ? parseJson(DerivativeDeclSchema, r.derivative, null as unknown as DerivativeDecl) : null,
  };
}
export async function setStyleProfile(novelId: string, profile: StyleProfile | null): Promise<void> {
  await getDb().execute('UPDATE novels SET style_profile = ?, updated_at = ? WHERE id = ?', [profile ? JSON.stringify(profile) : null, now(), novelId]);
}
export async function setDerivative(novelId: string, decl: DerivativeDecl | null): Promise<void> {
  await getDb().execute('UPDATE novels SET derivative = ?, updated_at = ? WHERE id = ?', [decl ? JSON.stringify(decl) : null, now(), novelId]);
}

/** Assemble the editable rows into a StorylineDoc (chapters come from the chapters table). */
export async function buildStorylineDoc(novelId: string, premise: string, themes: string[] = []): Promise<StorylineDoc> {
  const [characters, settings, arcs, beats, chapters, extras] = await Promise.all([
    listCharacters(novelId), listSettings(novelId), listArcs(novelId), listBeats(novelId), listChapters(novelId), getStyleExtras(novelId),
  ]);
  const chapterPlans: ChapterPlan[] = chapters.map((c) => ({
    chapterNo: c.chapterNo, title: c.title, goal: c.goal, beatIds: c.beatIds, povCharacterId: c.povCharacterId, targetChars: c.targetChars, endHook: c.endHook,
  }));
  return { ...emptyStoryline(), premise, themes, characters, settings, arcs, beats, chapters: chapterPlans, ...extras };
}

/** Replace all storyline rows from a doc (used for import / fork / generated outline). Chapter rows are handled by chaptersRepo. */
export async function replaceStorylineRows(novelId: string, doc: StorylineDoc): Promise<void> {
  const db = getDb();
  for (const t of ['characters', 'settings', 'arcs', 'beats'] as const) await db.execute(`DELETE FROM storyline_${t} WHERE novel_id = ?`, [novelId]);
  let i = 0;
  for (const c of doc.characters) await upsertCharacter(novelId, c, i++);
  i = 0;
  for (const s of doc.settings) await upsertSetting(novelId, s, i++);
  i = 0;
  for (const a of doc.arcs) await upsertArc(novelId, a, i++);
  i = 0;
  for (const b of doc.beats) await upsertBeat(novelId, b, b.order || i++);
  if (doc.styleProfile) await setStyleProfile(novelId, doc.styleProfile);
  if (doc.derivative) await setDerivative(novelId, doc.derivative);
}

export async function createSnapshot(novelId: string, doc: StorylineDoc, reason: SnapshotReason): Promise<StorylineSnapshot> {
  const id = nanoid();
  const t = now();
  await getDb().execute('INSERT INTO storyline_snapshots(id, novel_id, json, reason, created_at) VALUES (?,?,?,?,?)', [id, novelId, JSON.stringify(doc), reason, t]);
  return { id, novelId, doc, reason, createdAt: t };
}
interface RawSnap { id: string; novel_id: string; json: string; reason: string; created_at: number }
const mapSnap = (r: RawSnap): StorylineSnapshot => ({ id: r.id, novelId: r.novel_id, doc: parseJson(StorylineDocSchema, r.json, emptyStoryline()), reason: r.reason as SnapshotReason, createdAt: r.created_at });
export async function getSnapshot(id: string): Promise<StorylineSnapshot | null> {
  const r = await selectOne<RawSnap>('SELECT * FROM storyline_snapshots WHERE id = ?', [id]);
  return r ? mapSnap(r) : null;
}
export async function latestSnapshot(novelId: string): Promise<StorylineSnapshot | null> {
  const r = await selectOne<RawSnap>('SELECT * FROM storyline_snapshots WHERE novel_id = ? ORDER BY created_at DESC LIMIT 1', [novelId]);
  return r ? mapSnap(r) : null;
}
export async function listSnapshots(novelId: string): Promise<StorylineSnapshot[]> {
  return (await getDb().select<RawSnap>('SELECT * FROM storyline_snapshots WHERE novel_id = ? ORDER BY created_at DESC', [novelId])).map(mapSnap);
}
