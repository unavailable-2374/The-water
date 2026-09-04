import { describe, expect, it } from 'vitest';
import { SettingSchema, StyleProfileSchema, emptyStyleProfile } from '@the-water/shared';
import {
  GENRE_PACKS,
  GENRE_PACK_IDS,
  applyGenreToProfile,
  genreLoreSettings,
  genreTargets,
  intersectGenreTargets,
  isEmptyGenre,
  mergeGenrePacks,
  mergedGenreOf,
  orderPresetsByGenre,
  packIdsForGenre,
  resolveGenrePackIds,
} from '@/novel/genrePacks';
import { mergeLoreSettings } from '@/llm/prompts/context';
import { lintText } from '@/novel/lint';
import { defaultRequirements } from '@/novel/types';
import { genreBlock } from '@/llm/prompts/base';
import { genreOutlineBlock } from '@/llm/prompts/outline';

describe('genre packs (L1)', () => {
  it('are well formed', () => {
    expect(GENRE_PACK_IDS).toHaveLength(6);
    expect(new Set(GENRE_PACK_IDS).size).toBe(6);
    for (const p of GENRE_PACKS) {
      expect(p.entries.length).toBeGreaterThan(0);
      expect(p.writingRules.length).toBeGreaterThan(0);
      expect(p.qc.length).toBeGreaterThan(0);
      expect(p.outlineHints.length).toBeGreaterThan(0);
      for (const e of p.entries) {
        expect(e.id.startsWith(`${p.id}:`)).toBe(true);
        expect(e.priority).toBeGreaterThanOrEqual(0);
        expect(e.priority).toBeLessThanOrEqual(100);
        expect(e.description.length).toBeGreaterThan(10);
      }
      for (const [, range] of Object.entries(p.targets)) expect(range![0]).toBeLessThan(range![1]);
    }
  });

  it('lore entries are valid Settings, so they reuse the lorebook injection', () => {
    const m = mergeGenrePacks(GENRE_PACK_IDS);
    for (const s of genreLoreSettings(m)) expect(() => SettingSchema.parse(s)).not.toThrow();
  });

  it('maps the legacy genre field to packs', () => {
    expect(packIdsForGenre('玄幻')).toEqual(['xianxia']);
    expect(packIdsForGenre('武侠')).toEqual(['wuxia']);
    expect(packIdsForGenre('')).toEqual([]);
    expect(packIdsForGenre('不存在的题材')).toEqual([]);
    // 显式选择优先；没选过时回落到旧字段，因此不需要 DB 迁移。
    expect(resolveGenrePackIds({ genre: '玄幻', genrePackIds: [] })).toEqual(['xianxia']);
    expect(resolveGenrePackIds({ genre: '玄幻', genrePackIds: ['scifi'] })).toEqual(['scifi']);
    expect(resolveGenrePackIds({ genre: '玄幻', genrePackIds: ['不存在'] })).toEqual(['xianxia']);
  });
});

describe('merge rules', () => {
  it('unions the negative lists and dedupes', () => {
    const m = mergeGenrePacks(['scifi', 'mystery']);
    expect(m.labels).toEqual(['科幻', '悬疑 / 推理']);
    const sci = GENRE_PACKS.find((p) => p.id === 'scifi')!;
    for (const w of sci.forbiddenWords) expect(m.forbiddenWords).toContain(w);
    expect(new Set(m.forbiddenWords).size).toBe(m.forbiddenWords.length);
    expect(new Set(m.qc).size).toBe(m.qc.length);
  });

  it('intersects numeric targets', () => {
    const m = mergeGenrePacks(['scifi', 'mystery']);
    // 科幻 14–26 ∩ 悬疑 12–24
    expect(m.targets.sentenceMean).toEqual([14, 24]);
    expect(m.conflicts).toEqual([]);
  });

  it('falls back to the later pack when the intersection is empty, and says so', () => {
    const { targets, conflicts } = intersectGenreTargets([
      { label: 'A', targets: { sentenceMean: [8, 12] } },
      { label: 'B', targets: { sentenceMean: [20, 30] } },
    ]);
    expect(targets.sentenceMean).toEqual([20, 30]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain('B');
  });

  it('every real pair of packs is combinable without conflict', () => {
    for (const a of GENRE_PACK_IDS) {
      for (const b of GENRE_PACK_IDS) {
        if (a === b) continue;
        expect(mergeGenrePacks([a, b]).conflicts).toEqual([]);
      }
    }
  });

  it('drops disabled lore entries', () => {
    const all = mergeGenrePacks(['xianxia']);
    expect(all.entries.map((e) => e.id)).toContain('xianxia:realms');
    const off = mergeGenrePacks(['xianxia'], ['xianxia:realms']);
    expect(off.entries.map((e) => e.id)).not.toContain('xianxia:realms');
    expect(off.entries.length).toBe(all.entries.length - 1);
  });

  it('is empty for an unknown or absent selection', () => {
    expect(isEmptyGenre(mergeGenrePacks([]))).toBe(true);
    expect(isEmptyGenre(mergeGenrePacks(['nope']))).toBe(true);
    expect(isEmptyGenre(mergedGenreOf(defaultRequirements()))).toBe(true);
  });
});

describe('L2 overrides L1', () => {
  it('keeps the novel entry when a genre entry has the same name', () => {
    const own = SettingSchema.parse({ id: 'own1', name: '境界体系', kind: 'rule', description: '本书自己的境界：一到九品。' });
    const merged = mergeLoreSettings([own], genreLoreSettings(mergeGenrePacks(['xianxia'])));
    const hits = merged.filter((s) => s.name === '境界体系');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe('own1');
    // 其余题材条目照常进来
    expect(merged.map((s) => s.id)).toContain('xianxia:qi');
  });

  it('only fills targets the profile left null, and never invents a profile', () => {
    const m = mergeGenrePacks(['xianxia']);
    expect(applyGenreToProfile(null, m)).toBeNull();
    const profile = emptyStyleProfile({ id: 'p', targets: { sentenceMean: [30, 40], burstiness: null, paragraphMean: null, dialogueRatio: null, exclamationPerK: null, ellipsisPerK: null, hard: ['sentenceMean'] } });
    const out = applyGenreToProfile(profile, m)!;
    expect(out.targets.sentenceMean).toEqual([30, 40]);
    expect(out.targets.burstiness).toEqual(m.targets.burstiness);
    expect(out.voice.genreConventions.text).toContain('境界');
    expect(() => StyleProfileSchema.parse(out)).not.toThrow();
  });

  it('genre targets are all soft, so they never force a rewrite', () => {
    expect(genreTargets(mergeGenrePacks(['xianxia'])).hard).toEqual([]);
    expect(genreTargets(mergeGenrePacks(['xianxia'])).sentenceMean).toEqual([10, 20]);
    expect(genreTargets(mergeGenrePacks([])).sentenceMean).toBeNull();
  });

  it('orders the genre presets first', () => {
    const m = mergeGenrePacks(['wuxia']);
    const ordered = orderPresetsByGenre([{ id: 'preset_light-humor' }, { id: 'preset_classical-wuxia' }], m);
    expect(ordered[0]!.id).toBe('preset_classical-wuxia');
  });
});

describe('genre lexicon reaches lint and the prompts', () => {
  const text = '他掏出手机看了一眼，说了句OK，转身走进客栈。'.repeat(12);

  it('reports genre-forbidden words as block-level', () => {
    const clean = lintText(text);
    expect(clean.issues.some((i) => i.rule.startsWith('genre-'))).toBe(false);
    const wuxia = lintText(text, { genre: mergeGenrePacks(['wuxia']) });
    const hits = wuxia.issues.filter((i) => i.rule === 'genre-avoid-word');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((i) => i.severity === 'block')).toBe(true);
    expect(hits.some((i) => i.message.includes('手机'))).toBe(true);
  });

  it('does not report the same word twice when the book also forbids it', () => {
    const genre = mergeGenrePacks(['wuxia']);
    const profile = emptyStyleProfile({ id: 'p', negatives: { avoidWords: ['手机'], avoidWordsSoft: { limitPerK: 1, list: [] }, avoidPatterns: [], antiExemplars: [], oocRedlines: [] } });
    const r = lintText(text, { genre, profile });
    expect(r.issues.some((i) => i.rule === 'profile-avoid-word' && i.message.includes('手机'))).toBe(false);
    expect(r.issues.some((i) => i.rule === 'genre-avoid-word' && i.message.includes('手机'))).toBe(true);
  });

  it('injects genre rules into the prose system prompt and the outline prompt', () => {
    const m = mergeGenrePacks(['wuxia']);
    const block = genreBlock(m);
    expect(block).toContain('题材惯例');
    expect(block).toContain('不要出现这些词');
    expect(genreBlock(mergeGenrePacks([]))).toBe('');
    const outline = genreOutlineBlock(m);
    expect(outline).toContain('江湖称谓与辈分');
    expect(outline).toContain('避开这些烂俗桥段');
    expect(genreOutlineBlock(mergeGenrePacks([]))).toBe('');
  });
});
