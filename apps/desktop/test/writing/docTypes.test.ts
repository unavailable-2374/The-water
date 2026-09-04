import { describe, expect, it } from 'vitest';
import { DEFAULT_DOC_TYPE, DOC_TYPES, DOC_TYPE_IDS, docTypeGuide } from '@/novel/docTypes';
import { presetsForGenre, profileFromFreeText, stylePresets } from '@/novel/stylePresets';
import { StyleProfileSchema } from '@the-water/shared';

describe('doc types', () => {
  it('covers the ten article types from docs/writing/README.md §3', () => {
    expect(DOC_TYPE_IDS).toHaveLength(10);
    for (const id of DOC_TYPE_IDS) {
      const g = DOC_TYPES[id];
      expect(g.outlineRules.length).toBeGreaterThan(0);
      expect(g.writingRules.length).toBeGreaterThan(0);
      expect(g.qc.length).toBeGreaterThan(0);
      expect(g.template).toMatch(/^docs\/writing\/templates\/.+\.md$/);
    }
  });
  it('falls back to the default type', () => {
    expect(docTypeGuide('nope').id).toBe(DEFAULT_DOC_TYPE);
    expect(docTypeGuide(null).id).toBe(DEFAULT_DOC_TYPE);
    expect(docTypeGuide('news').fiction).toBe(false);
  });
});

describe('style presets', () => {
  it('are valid StyleProfiles with constraints and voice', () => {
    const all = stylePresets();
    expect(all.length).toBeGreaterThanOrEqual(6);
    for (const p of all) {
      expect(() => StyleProfileSchema.parse(p)).not.toThrow();
      expect(p.source.kind).toBe('preset');
      expect(p.injection.humanReadableConstraints.length).toBeGreaterThanOrEqual(3);
      expect(p.voice.narrator.text.length).toBeGreaterThan(0);
    }
  });
  it('orders genre matches first', () => {
    const wuxia = presetsForGenre('武侠');
    expect(['冷峭克制', '古典白话']).toContain(wuxia[0]!.name);
    expect(presetsForGenre('')).toHaveLength(stylePresets().length);
  });
  it('wraps free text into a manual profile', () => {
    expect(profileFromFreeText('  ')).toBeNull();
    const p = profileFromFreeText('冷峭克制，多短句')!;
    expect(p.source.kind).toBe('manual');
    expect(p.injection.humanReadableConstraints).toEqual(['冷峭克制，多短句']);
  });
});
