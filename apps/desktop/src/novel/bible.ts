/**
 * Story bible maintenance (plan §3.3 step 5): apply a summarize-step delta to
 * produce a new bible snapshot, and derive per-chapter character appearances.
 * Pure functions; never mutate inputs.
 */
import type { StoryBible, StorylineDoc } from '@the-water/shared';
import type { BibleDelta } from './types';
import { BIBLE_CAPS as CAPS } from './config';

/** 上限值在 `novel/config.ts`；这里只做 re-export。 */
export const BIBLE_CAPS = CAPS;

const norm = (s: string): string => s.trim().toLowerCase();
const clip = (s: string, max: number): string => {
  const cps = Array.from(s.trim());
  return cps.length <= max ? cps.join('') : cps.slice(0, max).join('');
};

type BibleCharacterState = StoryBible['characters'][string];

function emptyState(name: string): BibleCharacterState {
  return { name, state: '', location: '', knowledge: '', relationships: [] };
}

/** name/alias (normalized) → character id, from the storyline doc. */
export function characterNameIndex(doc: StorylineDoc): Map<string, string> {
  const idx = new Map<string, string>();
  for (const c of doc.characters) {
    const k = norm(c.name);
    if (k && !idx.has(k)) idx.set(k, c.id);
    for (const a of c.aliases) {
      const ak = norm(a);
      if (ak && !idx.has(ak)) idx.set(ak, c.id);
    }
  }
  return idx;
}

export function applyBibleDelta(
  bible: StoryBible,
  delta: BibleDelta,
  chapterNo: number,
  doc: StorylineDoc,
  arcIdForChapter: string | null,
): StoryBible {
  const nameIdx = characterNameIndex(doc);
  const canonical = new Map(doc.characters.map((c) => [c.id, c.name] as const));
  const resolveKey = (name: string): { key: string; name: string } => {
    const id = nameIdx.get(norm(name));
    if (id) return { key: id, name: canonical.get(id) ?? name.trim() };
    // Fallback: an existing bible entry keyed by this name (case-insensitive).
    const existing = Object.keys(bible.characters).find((k) => norm(k) === norm(name) || norm(bible.characters[k]!.name) === norm(name));
    return existing ? { key: existing, name: bible.characters[existing]!.name || name.trim() } : { key: name.trim(), name: name.trim() };
  };

  const characters: Record<string, BibleCharacterState> = {};
  for (const [k, v] of Object.entries(bible.characters)) characters[k] = { ...v, relationships: [...v.relationships] };

  for (const nc of delta.newCharacters) {
    if (!nc.name.trim()) continue;
    const { key, name } = resolveKey(nc.name);
    const desc = [nc.role.trim() ? `角色：${nc.role.trim()}` : '', nc.description.trim()].filter(Boolean).join('；');
    const cur = characters[key] ?? emptyState(name);
    characters[key] = { ...cur, name: cur.name || name, state: cur.state || clip(desc, 2000) };
  }

  for (const u of delta.characterUpdates) {
    if (!u.name.trim()) continue;
    const { key, name } = resolveKey(u.name);
    const cur = characters[key] ?? emptyState(name);
    const rels = [...cur.relationships];
    for (const r of u.relationshipChanges) {
      const t = clip(r, 300);
      if (t && !rels.includes(t)) rels.push(t);
    }
    characters[key] = {
      name: cur.name || name,
      state: u.state.trim() ? clip(u.state, 2000) : cur.state,
      location: u.location.trim() ? clip(u.location, 200) : cur.location,
      knowledge: u.knowledge.trim() ? clip(u.knowledge, 2000) : cur.knowledge,
      relationships: rels,
    };
  }

  const timeline = (
    [...bible.timeline, ...delta.timelineEvents.map((e) => e.event.trim()).filter(Boolean).map((event) => ({ chapterNo, event: clip(event, 500) }))]
  );

  const facts = [...bible.facts];
  const factSet = new Set(facts.map(norm));
  for (const f of delta.newFacts) {
    const t = clip(f, 500);
    if (t && !factSet.has(norm(t))) {
      facts.push(t);
      factSet.add(norm(t));
    }
  }

  const closed = delta.closedThreads.map(norm).filter(Boolean);
  const isClosed = (thread: string) => {
    const t = norm(thread);
    return closed.some((c) => c === t);
  };
  const openThreads = bible.openThreads.filter((t) => !isClosed(t));
  const openSet = new Set(openThreads.map(norm));
  for (const t of delta.openThreads) {
    const c = clip(t, 500);
    if (c && !openSet.has(norm(c)) && !isClosed(c)) {
      openThreads.push(c);
      openSet.add(norm(c));
    }
  }

  const arcSummaries = { ...bible.arcSummaries };
  if (arcIdForChapter && delta.arcSummary && delta.arcSummary.trim()) {
    arcSummaries[arcIdForChapter] = clip(delta.arcSummary, 4000);
  }

  return {
    characters,
    timeline,
    facts,
    openThreads,
    arcSummaries,
    styleNotes: bible.styleNotes,
  };
}

/**
 * chapterNo → set of character ids (or bible keys/names when not in the doc)
 * mentioned in the timeline events of that chapter, up to `uptoChapterNo`.
 */
export function bibleAppearances(bible: StoryBible, uptoChapterNo: number, doc?: StorylineDoc): Map<number, Set<string>> {
  const matchers: Array<{ key: string; needles: string[] }> = [];
  const covered = new Set<string>();
  if (doc) {
    for (const c of doc.characters) {
      matchers.push({ key: c.id, needles: [c.name, ...c.aliases].map((s) => s.trim()).filter(Boolean) });
      covered.add(c.id);
      covered.add(norm(c.name));
    }
  }
  for (const [key, st] of Object.entries(bible.characters)) {
    if (covered.has(key) || covered.has(norm(st.name))) continue;
    matchers.push({ key, needles: [st.name, key].map((s) => s.trim()).filter(Boolean) });
  }

  const out = new Map<number, Set<string>>();
  for (const e of bible.timeline) {
    if (e.chapterNo > uptoChapterNo) continue;
    for (const m of matchers) {
      if (m.needles.some((n) => e.event.includes(n))) {
        let set = out.get(e.chapterNo);
        if (!set) {
          set = new Set();
          out.set(e.chapterNo, set);
        }
        set.add(m.key);
      }
    }
  }
  return out;
}
