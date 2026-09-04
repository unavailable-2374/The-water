import { describe, expect, it } from 'vitest';
import { languageOf, pickPreferredLocale, resolveLocale } from '@/i18n/locale';
import { DEFAULT_LOCALE, LOCALES } from '@/i18n/types';

describe('languageOf', () => {
  it('取语言标签的语言段', () => {
    expect(languageOf('zh-CN')).toBe('zh');
    expect(languageOf('zh_Hans_CN')).toBe('zh');
    expect(languageOf('EN-us')).toBe('en');
    expect(languageOf('  ja  ')).toBe('ja');
  });
  it('空串照常返回空串，不抛错', () => {
    expect(languageOf('')).toBe('');
  });
});

describe('resolveLocale', () => {
  it('完全相同优先', () => {
    expect(resolveLocale('en-US')).toBe('en-US');
    expect(resolveLocale('zh-CN')).toBe('zh-CN');
  });
  it('大小写不敏感', () => {
    expect(resolveLocale('EN-us')).toBe('en-US');
  });
  it('同语言不同地区回落到该语言', () => {
    expect(resolveLocale('zh-TW')).toBe('zh-CN');
    expect(resolveLocale('zh')).toBe('zh-CN');
    expect(resolveLocale('en-GB')).toBe('en-US');
    expect(resolveLocale('en')).toBe('en-US');
  });
  it('认不出的语言回落到默认语言', () => {
    expect(resolveLocale('ja-JP')).toBe(DEFAULT_LOCALE);
    expect(resolveLocale('klingon')).toBe(DEFAULT_LOCALE);
  });
  it('空值 / 乱码不抛错', () => {
    expect(resolveLocale(null)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale('')).toBe(DEFAULT_LOCALE);
    expect(resolveLocale('   ')).toBe(DEFAULT_LOCALE);
    expect(resolveLocale('---')).toBe(DEFAULT_LOCALE);
  });
  it('候选集合里没有默认语言时退到第一个候选', () => {
    expect(resolveLocale('ja', ['en-US'])).toBe('en-US');
  });
});

describe('pickPreferredLocale', () => {
  it('按顺序挑第一个能对上的', () => {
    expect(pickPreferredLocale(['ja-JP', 'en-GB', 'zh-CN'])).toBe('en-US');
  });
  it('完全对得上的优先于同语言回落', () => {
    expect(pickPreferredLocale(['zh-CN'])).toBe('zh-CN');
  });
  it('一个都对不上就用默认语言', () => {
    expect(pickPreferredLocale(['ja-JP', 'ko-KR'])).toBe(DEFAULT_LOCALE);
    expect(pickPreferredLocale([])).toBe(DEFAULT_LOCALE);
    expect(pickPreferredLocale(undefined)).toBe(DEFAULT_LOCALE);
  });
});

describe('LOCALES', () => {
  it('默认语言必须在支持列表里', () => {
    expect(LOCALES).toContain(DEFAULT_LOCALE);
  });
});
