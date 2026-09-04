/**
 * Storyline diff (plan §3.5): compare two StorylineDoc snapshots entity-by-entity
 * (keyed by `id`, chapters by `chapterNo`) and report field-level changes.
 * Pure; never mutates inputs.
 */
import type { Arc, Beat, Character, ChapterPlan, Setting, StorylineDoc } from '@the-water/shared';

export interface FieldChange {
  id: string;
  fields: string[];
  before: unknown;
  after: unknown;
}
export interface EntityDiff<T> {
  added: T[];
  removed: T[];
  changed: FieldChange[];
}
export interface BeatDiff extends EntityDiff<Beat> {
  moved: Array<{ id: string; fromChapterNo: number | null; toChapterNo: number | null }>;
}
export interface StorylineDiff {
  premiseChanged: boolean;
  themesChanged: boolean;
  characters: EntityDiff<Character>;
  settings: EntityDiff<Setting>;
  arcs: EntityDiff<Arc>;
  beats: BeatDiff;
  /** Per-chapter field changes; added/removed chapter plans appear with fields ['added'] / ['removed']. */
  chapters: Array<{ chapterNo: number; fields: string[] }>;
  isEmpty: boolean;
}

/** Array fields compared as sets (order-insensitive). `beatIds` stays order-sensitive. */
const UNORDERED_FIELDS = new Set(['aliases', 'characterIds', 'settingIds', 'relationships', 'themes']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined).sort();
    const kb = Object.keys(b).filter((k) => b[k] !== undefined).sort();
    if (ka.length !== kb.length) return false;
    return ka.every((k, i) => k === kb[i] && deepEqual(a[k], b[k]));
  }
  return false;
}

const stableKey = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v, isObj(v) ? Object.keys(v).sort() : undefined));

function unorderedEqual(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return deepEqual(a, b);
  if (a.length !== b.length) return false;
  const sa = a.map(stableKey).sort();
  const sb = b.map(stableKey).sort();
  return sa.every((x, i) => x === sb[i]);
}

function fieldEqual(field: string, a: unknown, b: unknown): boolean {
  return UNORDERED_FIELDS.has(field) ? unorderedEqual(a, b) : deepEqual(a, b);
}

/** Names of fields (excluding `keyField`) whose values differ between two records. */
function changedFields(a: Record<string, unknown>, b: Record<string, unknown>, keyField: string): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete(keyField);
  return [...keys].filter((k) => !fieldEqual(k, a[k], b[k]));
}

function diffEntities<T extends { id: string }>(before: T[], after: T[]): EntityDiff<T> {
  const bMap = new Map(before.map((e) => [e.id, e] as const));
  const aMap = new Map(after.map((e) => [e.id, e] as const));
  const added = after.filter((e) => !bMap.has(e.id));
  const removed = before.filter((e) => !aMap.has(e.id));
  const changed: FieldChange[] = [];
  for (const b of before) {
    const a = aMap.get(b.id);
    if (!a) continue;
    const fields = changedFields(b as Record<string, unknown>, a as Record<string, unknown>, 'id');
    if (fields.length) changed.push({ id: b.id, fields, before: b, after: a });
  }
  return { added, removed, changed };
}

function diffChapters(before: ChapterPlan[], after: ChapterPlan[]): StorylineDiff['chapters'] {
  const bMap = new Map(before.map((c) => [c.chapterNo, c] as const));
  const aMap = new Map(after.map((c) => [c.chapterNo, c] as const));
  const out: StorylineDiff['chapters'] = [];
  for (const b of before) {
    const a = aMap.get(b.chapterNo);
    if (!a) {
      out.push({ chapterNo: b.chapterNo, fields: ['removed'] });
      continue;
    }
    const fields = changedFields(b as Record<string, unknown>, a as Record<string, unknown>, 'chapterNo');
    if (fields.length) out.push({ chapterNo: b.chapterNo, fields });
  }
  for (const a of after) if (!bMap.has(a.chapterNo)) out.push({ chapterNo: a.chapterNo, fields: ['added'] });
  return out.sort((x, y) => x.chapterNo - y.chapterNo);
}

export function diffStoryline(before: StorylineDoc, after: StorylineDoc): StorylineDiff {
  const characters = diffEntities(before.characters, after.characters);
  const settings = diffEntities(before.settings, after.settings);
  const arcs = diffEntities(before.arcs, after.arcs);
  const beatBase = diffEntities(before.beats, after.beats);
  const moved: BeatDiff['moved'] = beatBase.changed
    .filter((c) => c.fields.includes('chapterNo'))
    .map((c) => ({ id: c.id, fromChapterNo: (c.before as Beat).chapterNo, toChapterNo: (c.after as Beat).chapterNo }));
  const beats: BeatDiff = { ...beatBase, moved };
  const chapters = diffChapters(before.chapters, after.chapters);
  const premiseChanged = before.premise !== after.premise;
  const themesChanged = !unorderedEqual(before.themes, after.themes);

  const nonEmpty = (d: EntityDiff<unknown>) => d.added.length > 0 || d.removed.length > 0 || d.changed.length > 0;
  const isEmpty = !premiseChanged && !themesChanged && !nonEmpty(characters) && !nonEmpty(settings) && !nonEmpty(arcs) && !nonEmpty(beats) && chapters.length === 0;

  return { premiseChanged, themesChanged, characters, settings, arcs, beats, chapters, isEmpty };
}

// ---- Human-readable summary ----

const chapterLabel = (n: number | null | undefined): string => (n == null ? '未分配章节' : `第${n}章`);
const joinFields = (fields: string[]): string => fields.join('、');

function nameOf<T extends { id: string }>(id: string, after: T[], before: T[], pick: (e: T) => string): string {
  const a = after.find((e) => e.id === id);
  if (a) return pick(a);
  const b = before.find((e) => e.id === id);
  return b ? pick(b) : id;
}

function entityLines<T extends { id: string }>(
  label: string,
  d: EntityDiff<T>,
  after: T[],
  before: T[],
  pick: (e: T) => string,
  extra?: (c: FieldChange) => string,
): string[] {
  const lines: string[] = [];
  for (const e of d.added) lines.push(`- 新增${label}「${pick(e)}」`);
  for (const e of d.removed) lines.push(`- 删除${label}「${pick(e)}」`);
  for (const c of d.changed) {
    const oldName = pick(c.before as T);
    const newName = nameOf(c.id, after, before, pick);
    const head = oldName !== newName ? `${label}「${oldName}」→「${newName}」` : `${label}「${newName}」`;
    lines.push(`- ${head}：修改了 ${joinFields(c.fields)}${extra ? extra(c) : ''}`);
  }
  return lines;
}

/** Chinese bullet list describing the diff, for prompts and UI. */
export function summarizeDiff(diff: StorylineDiff, after: StorylineDoc, before: StorylineDoc): string {
  if (diff.isEmpty) return '（无变更）';
  const lines: string[] = [];
  if (diff.premiseChanged) lines.push('- 前提已修改');
  if (diff.themesChanged) lines.push(`- 主题已修改：${before.themes.join('、') || '（空）'} → ${after.themes.join('、') || '（空）'}`);

  lines.push(...entityLines('人物', diff.characters, after.characters, before.characters, (c) => c.name));
  lines.push(...entityLines('设定', diff.settings, after.settings, before.settings, (s) => s.name));
  lines.push(...entityLines('故事弧', diff.arcs, after.arcs, before.arcs, (a) => a.title, (c) => {
    const b = c.before as Arc;
    const a = c.after as Arc;
    const rangeChanged = b.startChapterNo !== a.startChapterNo || b.endChapterNo !== a.endChapterNo;
    return rangeChanged ? `（章节范围 ${b.startChapterNo}–${b.endChapterNo} → ${a.startChapterNo}–${a.endChapterNo}）` : '';
  }));

  for (const b of diff.beats.added) lines.push(`- 新增节拍「${b.title}」（${chapterLabel(b.chapterNo)}）`);
  for (const b of diff.beats.removed) lines.push(`- 删除节拍「${b.title}」（${chapterLabel(b.chapterNo)}）`);
  const movedIds = new Set(diff.beats.moved.map((m) => m.id));
  for (const c of diff.beats.changed) {
    const title = (c.after as Beat).title;
    const fields = c.fields.filter((f) => f !== 'chapterNo');
    if (fields.length) lines.push(`- 节拍「${title}」：修改了 ${joinFields(fields)}`);
    if (movedIds.has(c.id)) {
      const m = diff.beats.moved.find((x) => x.id === c.id)!;
      lines.push(`- 节拍「${title}」从${chapterLabel(m.fromChapterNo)}移至${chapterLabel(m.toChapterNo)}`);
    }
  }

  for (const ch of diff.chapters) {
    if (ch.fields.includes('added')) lines.push(`- 第${ch.chapterNo}章：新增章节规划`);
    else if (ch.fields.includes('removed')) lines.push(`- 第${ch.chapterNo}章：删除章节规划`);
    else lines.push(`- 第${ch.chapterNo}章：修改了 ${joinFields(ch.fields)}`);
  }
  return lines.join('\n');
}
