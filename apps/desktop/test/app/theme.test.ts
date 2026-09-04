import { describe, expect, it } from 'vitest';
import { THEME_PREFS, normalizeThemePref, resolveTheme } from '@/app/theme';

describe('resolveTheme', () => {
  it('明确选了就用明确的，与系统无关', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('dark', true)).toBe('dark');
  });

  it('跟随系统时按 prefers-color-scheme', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('三个选项都能解析出 light 或 dark', () => {
    for (const pref of THEME_PREFS) {
      expect(['light', 'dark']).toContain(resolveTheme(pref, false));
      expect(['light', 'dark']).toContain(resolveTheme(pref, true));
    }
  });
});

describe('normalizeThemePref', () => {
  it('认得三个合法值', () => {
    expect(normalizeThemePref('system')).toBe('system');
    expect(normalizeThemePref('light')).toBe('light');
    expect(normalizeThemePref('dark')).toBe('dark');
  });

  it('脏数据一律回落到跟随系统', () => {
    for (const bad of [null, undefined, '', 'DARK', 'auto', 0, {}, []]) {
      expect(normalizeThemePref(bad)).toBe('system');
    }
  });
});
