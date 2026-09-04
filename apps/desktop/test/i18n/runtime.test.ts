/**
 * `t` 的运行时行为：切语言之后，**之前就拿到手的引用**也要跟着变。
 * 这正是「模块顶层把文案拷进常量表」那种写法会踩的坑，所以专门测一遍。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { availableLocales, currentLocale, fmt, setLocale, t } from '@/i18n';
import { LOCALES } from '@/i18n/types';
import { zh } from '@/i18n/zh';
import { en } from '@/i18n/en';

afterEach(() => { setLocale('zh-CN'); });

describe('t', () => {
  it('默认是简体中文', () => {
    expect(currentLocale()).toBe('zh-CN');
    expect(t.common.save).toBe(zh.common.save);
  });

  it('切语言后取到的是新语言的文案', () => {
    setLocale('en-US');
    expect(currentLocale()).toBe('en-US');
    expect(t.common.save).toBe(en.common.save);
    setLocale('zh-CN');
    expect(t.common.save).toBe(zh.common.save);
  });

  it('提前拿到的子对象引用也会跟着切（不会停在旧语言）', () => {
    const common = t.common;
    setLocale('en-US');
    expect(common.save).toBe(en.common.save);
    setLocale('zh-CN');
    expect(common.save).toBe(zh.common.save);
  });

  it('可以像普通对象那样遍历与展开', () => {
    expect(Object.keys(t.jobs.status).sort()).toEqual(Object.keys(zh.jobs.status).sort());
    expect({ ...t.novelStatus }).toEqual({ ...zh.novelStatus });
    expect('save' in t.common).toBe(true);
    expect(Object.entries(t.novelStatus).length).toBeGreaterThan(0);
  });

  it('认不出的语言标签回落到默认语言，不抛错', () => {
    expect(setLocale('ja-JP')).toBe('zh-CN');
    expect(currentLocale()).toBe('zh-CN');
  });

  it('availableLocales 覆盖所有声明支持的语言', () => {
    expect(availableLocales().map((l) => l.code).sort()).toEqual([...LOCALES].sort());
    for (const l of availableLocales()) expect(l.nativeName.trim()).not.toBe('');
  });
});

describe('fmt', () => {
  it('替换占位符', () => {
    expect(fmt('第 {n} 页', { n: 3 })).toBe('第 3 页');
    expect(fmt('{a} 与 {b}', { a: '甲', b: '乙' })).toBe('甲 与 乙');
  });
  it('缺变量时用空串顶上，不会把 {x} 原样显示给用户', () => {
    expect(fmt('你好 {name}', {})).toBe('你好 ');
  });
  it('没有占位符时原样返回', () => {
    expect(fmt('没有占位符', { a: 1 })).toBe('没有占位符');
  });
});
