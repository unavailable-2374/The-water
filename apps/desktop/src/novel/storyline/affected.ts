/**
 * Affected-chapter computation and rewrite plan (plan §3.5). Deterministic rules
 * mapping a StorylineDiff onto chapters that already have generated text.
 * Pure; never mutates inputs.
 */
import type { Arc, Beat, Character, Setting, StorylineDoc } from '@the-water/shared';
import type { StorylineDiff } from './diff';

export type RewriteMode = 'rewrite' | 'revise' | 'name_replace';

export interface AffectedReason {
  code:
    | 'chapter_plan'
    | 'beat_changed'
    | 'beat_moved'
    | 'beat_added'
    | 'beat_removed'
    | 'character_renamed'
    | 'character_changed'
    | 'pov_changed'
    | 'setting_changed'
    | 'arc_changed'
    | 'entity_removed'
    | 'continuity';
  text: string;
}

export interface NameReplacement {
  from: string;
  to: string;
}

export interface AffectedChapter {
  chapterNo: number;
  mode: RewriteMode;
  reasons: AffectedReason[];
  /** Continuity ripple only (not directly affected). */
  stale: boolean;
  nameReplacements?: NameReplacement[];
}

export interface AffectedInput {
  diff: StorylineDiff;
  before: StorylineDoc;
  after: StorylineDoc;
  /**
   * chapterNo → set of character/setting ids appearing in that chapter (from bible
   * timeline + summaries). Optional; always unioned with what the beats/POV imply,
   * since the bible only tracks characters.
   */
  appearances?: Map<number, Set<string>>;
  /** Chapters that actually have generated text; others are never "affected". */
  writtenChapterNos: Set<number>;
}

export interface RewritePlanItem {
  chapterNo: number;
  mode: RewriteMode;
  reasons: AffectedReason[];
  selected: boolean;
  stale: boolean;
  nameReplacements?: NameReplacement[];
}

const MODE_RANK: Record<RewriteMode, number> = { rewrite: 3, revise: 2, name_replace: 1 };
const CONTINUITY_TEXT = '前文已重写，可能影响连贯性';
const NAME_FIELDS = new Set(['name', 'aliases']);
const BEAT_CONTENT_FIELDS = new Set(['title', 'summary', 'characterIds', 'settingIds']);
const CHAPTER_REWRITE_FIELDS = new Set(['goal', 'beatIds']);
const CHAPTER_REVISE_FIELDS = new Set(['title', 'endHook', 'targetChars']);

const chapterLabel = (n: number | null): string => (n == null ? '未分配章节' : `第${n}章`);
const joinFields = (fields: string[]): string => fields.join('、');

/** The chapter a beat belongs to: beat.chapterNo, else the chapter whose beatIds includes it. */
export function beatChapterNo(doc: StorylineDoc, beat: Beat): number | null {
  if (beat.chapterNo != null) return beat.chapterNo;
  const ch = doc.chapters.find((c) => c.beatIds.includes(beat.id));
  return ch ? ch.chapterNo : null;
}

/** chapterNo → ids of characters/settings implied by the plan (beats + POV). */
export function deriveAppearances(doc: StorylineDoc): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  const bucket = (n: number): Set<string> => {
    let s = out.get(n);
    if (!s) {
      s = new Set();
      out.set(n, s);
    }
    return s;
  };
  for (const ch of doc.chapters) {
    const s = bucket(ch.chapterNo);
    if (ch.povCharacterId) s.add(ch.povCharacterId);
  }
  for (const b of doc.beats) {
    const n = beatChapterNo(doc, b);
    if (n == null) continue;
    const s = bucket(n);
    for (const id of b.characterIds) s.add(id);
    for (const id of b.settingIds) s.add(id);
  }
  return out;
}

function mergeAppearances(...maps: Array<Map<number, Set<string>> | undefined>): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  for (const m of maps) {
    if (!m) continue;
    for (const [n, ids] of m) {
      let s = out.get(n);
      if (!s) {
        s = new Set();
        out.set(n, s);
      }
      for (const id of ids) s.add(id);
    }
  }
  return out;
}

function chaptersWith(appearances: Map<number, Set<string>>, id: string): number[] {
  const out: number[] = [];
  for (const [n, ids] of appearances) if (ids.has(id)) out.push(n);
  return out.sort((a, b) => a - b);
}

const range = (a: number, b: number): number[] => {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
};

interface Acc {
  chapterNo: number;
  mode: RewriteMode;
  reasons: Map<string, AffectedReason>;
  reps: Map<string, string>;
}

/** Pair removed aliases with added aliases by index; leftover removed aliases map to the new name. */
function aliasReplacements(before: Character, after: Character): NameReplacement[] {
  const removed = before.aliases.filter((a) => !after.aliases.includes(a));
  const added = after.aliases.filter((a) => !before.aliases.includes(a));
  const reps: NameReplacement[] = [];
  removed.forEach((from, i) => {
    const to = added[i] ?? after.name;
    if (from && to && from !== to) reps.push({ from, to });
  });
  return reps;
}

export function computeAffectedChapters(input: AffectedInput): AffectedChapter[] {
  const { diff, before, after, writtenChapterNos } = input;
  const appearances = mergeAppearances(input.appearances, deriveAppearances(before), deriveAppearances(after));
  const acc = new Map<number, Acc>();

  const mark = (chapterNo: number | null, mode: RewriteMode, reason: AffectedReason, reps?: NameReplacement[]): void => {
    if (chapterNo == null || !writtenChapterNos.has(chapterNo)) return;
    let a = acc.get(chapterNo);
    if (!a) {
      a = { chapterNo, mode, reasons: new Map(), reps: new Map() };
      acc.set(chapterNo, a);
    }
    if (MODE_RANK[mode] > MODE_RANK[a.mode]) a.mode = mode;
    a.reasons.set(`${reason.code} ${reason.text}`, reason);
    for (const r of reps ?? []) if (r.from && r.to && r.from !== r.to && !a.reps.has(r.from)) a.reps.set(r.from, r.to);
  };

  // 1. Chapter plan changes.
  for (const ch of diff.chapters) {
    if (ch.fields.includes('added')) {
      mark(ch.chapterNo, 'rewrite', { code: 'chapter_plan', text: '新增章节规划' });
      continue;
    }
    if (ch.fields.includes('removed')) {
      mark(ch.chapterNo, 'rewrite', { code: 'chapter_plan', text: '章节规划已删除' });
      continue;
    }
    const rewriteFields = ch.fields.filter((f) => CHAPTER_REWRITE_FIELDS.has(f));
    const reviseFields = ch.fields.filter((f) => CHAPTER_REVISE_FIELDS.has(f));
    if (rewriteFields.length) mark(ch.chapterNo, 'rewrite', { code: 'chapter_plan', text: `章节规划修改了 ${joinFields(rewriteFields)}` });
    if (ch.fields.includes('povCharacterId')) mark(ch.chapterNo, 'rewrite', { code: 'pov_changed', text: '视角人物已更换' });
    if (reviseFields.length) mark(ch.chapterNo, 'revise', { code: 'chapter_plan', text: `章节规划修改了 ${joinFields(reviseFields)}` });
  }

  // 2. Beats.
  for (const c of diff.beats.changed) {
    const fields = c.fields.filter((f) => BEAT_CONTENT_FIELDS.has(f));
    if (!fields.length) continue;
    const b = c.after as Beat;
    mark(beatChapterNo(after, b), 'rewrite', { code: 'beat_changed', text: `节拍「${b.title}」修改了 ${joinFields(fields)}` });
  }
  for (const m of diff.beats.moved) {
    const bBefore = before.beats.find((b) => b.id === m.id);
    const bAfter = after.beats.find((b) => b.id === m.id);
    const from = bBefore ? beatChapterNo(before, bBefore) : m.fromChapterNo;
    const to = bAfter ? beatChapterNo(after, bAfter) : m.toChapterNo;
    const reason: AffectedReason = {
      code: 'beat_moved',
      text: `节拍「${(bAfter ?? bBefore)?.title ?? m.id}」从${chapterLabel(from)}移至${chapterLabel(to)}`,
    };
    mark(from, 'rewrite', reason);
    mark(to, 'rewrite', reason);
  }
  for (const b of diff.beats.added) mark(beatChapterNo(after, b), 'rewrite', { code: 'beat_added', text: `新增节拍「${b.title}」` });
  for (const b of diff.beats.removed) mark(beatChapterNo(before, b), 'rewrite', { code: 'beat_removed', text: `删除节拍「${b.title}」` });

  // 3. Characters.
  for (const c of diff.characters.changed) {
    const bChar = c.before as Character;
    const aChar = c.after as Character;
    const chapters = chaptersWith(appearances, c.id);
    const nameFields = c.fields.filter((f) => NAME_FIELDS.has(f));
    const otherFields = c.fields.filter((f) => !NAME_FIELDS.has(f));

    if (nameFields.length) {
      const reps: NameReplacement[] = [];
      if (bChar.name !== aChar.name) reps.push({ from: bChar.name, to: aChar.name });
      reps.push(...aliasReplacements(bChar, aChar));
      const text = bChar.name !== aChar.name ? `人物「${bChar.name}」改名为「${aChar.name}」` : `人物「${aChar.name}」的别名已修改`;
      for (const n of chapters) mark(n, 'name_replace', { code: 'character_renamed', text }, reps);
    }
    if (otherFields.length) {
      const text = `人物「${aChar.name}」修改了 ${joinFields(otherFields)}`;
      const first = chapters[0];
      for (const n of chapters) if (first == null || n >= first) mark(n, 'revise', { code: 'character_changed', text });
      for (const ch of after.chapters) {
        if (ch.povCharacterId === c.id) mark(ch.chapterNo, 'rewrite', { code: 'pov_changed', text: `视角人物「${aChar.name}」的设定已修改` });
      }
    }
  }
  for (const c of diff.characters.removed) {
    for (const n of chaptersWith(appearances, c.id)) mark(n, 'rewrite', { code: 'entity_removed', text: `人物「${c.name}」已删除` });
  }

  // 4. Settings.
  for (const c of diff.settings.changed) {
    const s = c.after as Setting;
    for (const n of chaptersWith(appearances, c.id)) mark(n, 'revise', { code: 'setting_changed', text: `设定「${s.name}」修改了 ${joinFields(c.fields)}` });
  }
  for (const s of diff.settings.removed) {
    for (const n of chaptersWith(appearances, s.id)) mark(n, 'rewrite', { code: 'entity_removed', text: `设定「${s.name}」已删除` });
  }

  // 5. Arcs (lowest priority: only chapters not otherwise affected get the summary/title reason).
  for (const c of diff.arcs.changed) {
    const bArc = c.before as Arc;
    const aArc = c.after as Arc;
    const rangeChanged = c.fields.includes('startChapterNo') || c.fields.includes('endChapterNo');
    if (rangeChanged) {
      const bSet = new Set(range(bArc.startChapterNo, bArc.endChapterNo));
      const aSet = new Set(range(aArc.startChapterNo, aArc.endChapterNo));
      const symDiff = [...new Set([...bSet, ...aSet])].filter((n) => bSet.has(n) !== aSet.has(n));
      const text = `故事弧「${aArc.title}」章节范围由 ${bArc.startChapterNo}-${bArc.endChapterNo} 改为 ${aArc.startChapterNo}-${aArc.endChapterNo}`;
      for (const n of symDiff) mark(n, 'revise', { code: 'arc_changed', text });
    }
    const contentFields = c.fields.filter((f) => f === 'summary' || f === 'title');
    if (contentFields.length) {
      const text = `故事弧「${aArc.title}」修改了 ${joinFields(contentFields)}`;
      for (const n of range(aArc.startChapterNo, aArc.endChapterNo)) if (!acc.has(n)) mark(n, 'revise', { code: 'arc_changed', text });
    }
  }
  for (const a of diff.arcs.removed) {
    for (const n of range(a.startChapterNo, a.endChapterNo)) if (!acc.has(n)) mark(n, 'revise', { code: 'arc_changed', text: `故事弧「${a.title}」已删除` });
  }
  for (const a of diff.arcs.added) {
    for (const n of range(a.startChapterNo, a.endChapterNo)) if (!acc.has(n)) mark(n, 'revise', { code: 'arc_changed', text: `新增故事弧「${a.title}」` });
  }

  // 6. Continuity ripple after the earliest rewrite.
  const rewrites = [...acc.values()].filter((a) => a.mode === 'rewrite').map((a) => a.chapterNo);
  if (rewrites.length) {
    const earliest = Math.min(...rewrites);
    for (const n of writtenChapterNos) {
      if (n > earliest && !acc.has(n)) {
        const reason: AffectedReason = { code: 'continuity', text: CONTINUITY_TEXT };
        acc.set(n, { chapterNo: n, mode: 'revise', reasons: new Map([[`continuity ${CONTINUITY_TEXT}`, reason]]), reps: new Map() });
      }
    }
  }

  return [...acc.values()]
    .sort((x, y) => x.chapterNo - y.chapterNo)
    .map((a) => {
      const reasons = [...a.reasons.values()];
      const stale = reasons.length === 1 && reasons[0]!.code === 'continuity';
      const out: AffectedChapter = { chapterNo: a.chapterNo, mode: a.mode, reasons, stale };
      if (a.reps.size) out.nameReplacements = [...a.reps].map(([from, to]) => ({ from, to }));
      return out;
    });
}

export function buildRewritePlan(affected: AffectedChapter[], opts?: { includeContinuity?: boolean }): RewritePlanItem[] {
  const includeContinuity = opts?.includeContinuity ?? false;
  return affected.map((a) => {
    const item: RewritePlanItem = {
      chapterNo: a.chapterNo,
      mode: a.mode,
      reasons: a.reasons.map((r) => ({ ...r })),
      selected: a.stale ? includeContinuity : true,
      stale: a.stale,
    };
    if (a.nameReplacements?.length) item.nameReplacements = a.nameReplacements.map((r) => ({ ...r }));
    return item;
  });
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Single-pass, longest-match-first replacement of every occurrence; empty/identity pairs are skipped. */
export function applyNameReplacements(text: string, reps: NameReplacement[]): string {
  const map = new Map<string, string>();
  for (const r of reps) if (r.from && r.from !== r.to && !map.has(r.from)) map.set(r.from, r.to);
  if (!map.size) return text;
  const pattern = [...map.keys()]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map(escapeRegExp)
    .join('|');
  return text.replace(new RegExp(pattern, 'g'), (m) => map.get(m) ?? m);
}

// ---------------------------------------------------------------------------
// 按故事弧分组（§2.2 第 5 条）
// ---------------------------------------------------------------------------

export interface ArcGroup<T> {
  /** null 表示「不在任何一个弧的章节范围里」。 */
  arcId: string | null;
  title: string;
  startChapterNo: number | null;
  endChapterNo: number | null;
  items: T[];
}

/** 落在弧上的章节：范围包含它就算；同时落在多个弧里时取**最窄**的那个。 */
function arcForChapter(arcs: readonly Arc[], chapterNo: number): Arc | null {
  let best: Arc | null = null;
  let bestSpan = Infinity;
  for (const a of arcs) {
    const lo = Math.min(a.startChapterNo, a.endChapterNo);
    const hi = Math.max(a.startChapterNo, a.endChapterNo);
    if (chapterNo < lo || chapterNo > hi) continue;
    const span = hi - lo;
    if (span < bestSpan) { bestSpan = span; best = a; }
  }
  return best;
}

/**
 * 把改写计划行按故事弧分组，好让作者「整条弧一起勾」而不是一行行点。
 * 组的顺序按弧里最小的章号；不属于任何弧的行归到最后一组。
 */
export function groupByArc<T extends { chapterNo: number }>(items: readonly T[], arcs: readonly Arc[], fallbackTitle = '未归入故事弧'): Array<ArcGroup<T>> {
  const groups = new Map<string, ArcGroup<T>>();
  for (const it of [...items].sort((a, b) => a.chapterNo - b.chapterNo)) {
    const arc = arcForChapter(arcs, it.chapterNo);
    const key = arc?.id ?? '';
    let g = groups.get(key);
    if (!g) {
      g = arc
        ? { arcId: arc.id, title: arc.title || '未命名故事弧', startChapterNo: arc.startChapterNo, endChapterNo: arc.endChapterNo, items: [] }
        : { arcId: null, title: fallbackTitle, startChapterNo: null, endChapterNo: null, items: [] };
      groups.set(key, g);
    }
    g.items.push(it);
  }
  const out = [...groups.values()];
  const firstNo = (g: ArcGroup<T>) => g.items[0]?.chapterNo ?? Infinity;
  return out.sort((a, b) => (a.arcId === null ? 1 : 0) - (b.arcId === null ? 1 : 0) || firstNo(a) - firstNo(b));
}
