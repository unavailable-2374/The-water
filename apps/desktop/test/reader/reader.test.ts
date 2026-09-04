import { describe, expect, it } from 'vitest';
import { SHORTCUTS, matchShortcut, shortcutGroups, shouldIgnoreTarget, type KeyEventLike } from '@/features/reader/shortcuts';
import { indexByPage, insertHighlight, patchHighlight, removeHighlight } from '@/features/reader/highlightIndex';
import { buildHighlightsMarkdown, sanitize } from '@/features/reader/exportMarkdown';
import { clampPopover } from '@/features/reader/popover';
import { HIGHLIGHT_COLORS, colorCss } from '@/features/reader/colors';
import { READER_THEMES, THEME_ORDER } from '@/features/reader/theme';
import type { Highlight } from '@/db/repos/highlightsRepo';

const key = (k: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods,
});

describe('阅读器快捷键', () => {
  it('翻页键', () => {
    expect(matchShortcut(key('ArrowRight'))).toBe('nextPage');
    expect(matchShortcut(key('PageDown'))).toBe('nextPage');
    expect(matchShortcut(key(' '))).toBe('nextPage');
    expect(matchShortcut(key('ArrowLeft'))).toBe('prevPage');
    expect(matchShortcut(key('PageUp'))).toBe('prevPage');
    expect(matchShortcut(key(' ', { shiftKey: true }))).toBe('prevPage');
    expect(matchShortcut(key('Home'))).toBe('firstPage');
    expect(matchShortcut(key('End'))).toBe('lastPage');
  });

  it('缩放与查找认 Cmd 也认 Ctrl', () => {
    expect(matchShortcut(key('=', { metaKey: true }))).toBe('zoomIn');
    expect(matchShortcut(key('+', { ctrlKey: true }))).toBe('zoomIn');
    expect(matchShortcut(key('-', { ctrlKey: true }))).toBe('zoomOut');
    expect(matchShortcut(key('0', { metaKey: true }))).toBe('zoomReset');
    expect(matchShortcut(key('f', { metaKey: true }))).toBe('find');
    expect(matchShortcut(key('g', { metaKey: true }))).toBe('findNext');
    expect(matchShortcut(key('g', { metaKey: true, shiftKey: true }))).toBe('findPrev');
  });

  it('界面键', () => {
    expect(matchShortcut(key('b', { ctrlKey: true }))).toBe('toggleOutline');
    expect(matchShortcut(key('\\', { metaKey: true }))).toBe('toggleSidebar');
    expect(matchShortcut(key('?'))).toBe('help');
    expect(matchShortcut(key('Escape'))).toBe('escape');
  });

  it('没配的键不命中', () => {
    expect(matchShortcut(key('q'))).toBeNull();
    expect(matchShortcut(key('ArrowRight', { metaKey: true }))).toBeNull();
  });

  it('焦点在输入框时让位给输入，但 Esc 与组合键仍然生效', () => {
    expect(shouldIgnoreTarget('INPUT', false, key('ArrowRight'))).toBe(true);
    expect(shouldIgnoreTarget('TEXTAREA', false, key(' '))).toBe(true);
    expect(shouldIgnoreTarget('DIV', true, key('?'))).toBe(true);
    expect(shouldIgnoreTarget('INPUT', false, key('Escape'))).toBe(false);
    expect(shouldIgnoreTarget('INPUT', false, key('f', { metaKey: true }))).toBe(false);
    expect(shouldIgnoreTarget('DIV', false, key('ArrowRight'))).toBe(false);
    expect(shouldIgnoreTarget(undefined, false, key('ArrowRight'))).toBe(false);
  });

  it('帮助浮层覆盖全部键，且每个动作都可达', () => {
    const listed = shortcutGroups().flatMap((g) => g.items);
    expect(listed).toHaveLength(SHORTCUTS.length);
    for (const s of SHORTCUTS) expect(s.keys.length).toBeGreaterThan(0);
  });
});

const mkHighlight = (over: Partial<Highlight> = {}): Highlight => ({
  id: 'h1', documentId: 'd1', pageNo: 1, kind: 'highlight', color: 'yellow',
  anchor: { exact: '天地玄黄', prefix: '', suffix: '', start: 0, end: 4, rects: [] },
  noteText: '', createdAt: 1, updatedAt: 1, ...over,
});

describe('高亮按页索引与乐观更新', () => {
  it('按页分组并按创建时间排序', () => {
    const list = [
      mkHighlight({ id: 'b', pageNo: 2, createdAt: 5 }),
      mkHighlight({ id: 'a', pageNo: 1, createdAt: 9 }),
      mkHighlight({ id: 'c', pageNo: 1, createdAt: 3 }),
    ];
    const idx = indexByPage(list);
    expect(Object.keys(idx).sort()).toEqual(['1', '2']);
    expect(idx[1]!.map((h) => h.id)).toEqual(['c', 'a']);
    expect(idx[2]!.map((h) => h.id)).toEqual(['b']);
    expect(indexByPage([])).toEqual({});
  });

  it('插入不重复、按页与时间排好序', () => {
    const list = [mkHighlight({ id: 'a', pageNo: 2, createdAt: 1 })];
    const next = insertHighlight(list, mkHighlight({ id: 'b', pageNo: 1, createdAt: 2 }));
    expect(next.map((h) => h.id)).toEqual(['b', 'a']);
    const again = insertHighlight(next, mkHighlight({ id: 'b', pageNo: 1, createdAt: 2, noteText: '改了' }));
    expect(again).toHaveLength(2);
    expect(again.find((h) => h.id === 'b')!.noteText).toBe('改了');
  });

  it('局部改写与删除都不动其它条目', () => {
    const list = [mkHighlight({ id: 'a' }), mkHighlight({ id: 'b' })];
    const patched = patchHighlight(list, 'a', { color: 'green' });
    expect(patched[0]!.color).toBe('green');
    expect(patched[1]).toBe(list[1]);
    expect(removeHighlight(patched, 'a').map((h) => h.id)).toEqual(['b']);
    expect(removeHighlight(list, '不存在')).toHaveLength(2);
  });
});

describe('划线导出 Markdown', () => {
  const doc = { title: '天工开物', author: '宋应星', pageCount: 100 };
  const at = new Date(2026, 8, 4, 10, 30);

  it('按页分组，带原文引用与页码', () => {
    const md = buildHighlightsMarkdown(doc, [
      mkHighlight({ id: 'a', pageNo: 3, anchor: { exact: '乃粒第一', prefix: '', suffix: '', start: 0, end: 4, rects: [] }, noteText: '记一笔', color: 'green' }),
      mkHighlight({ id: 'b', pageNo: 1, anchor: { exact: '天工开物', prefix: '', suffix: '', start: 0, end: 4, rects: [] } }),
    ], at);
    expect(md).toContain('# 天工开物');
    expect(md).toContain('宋应星');
    expect(md).toContain('2 条划线与笔记');
    expect(md).toContain('2026-09-04 10:30');
    expect(md.indexOf('## 第 1 页')).toBeLessThan(md.indexOf('## 第 3 页'));
    expect(md).toContain('> 乃粒第一');
    expect(md).toContain('**笔记（绿）**：记一笔');
    expect(md).toContain('— 第 3 页');
  });

  it('没有划线时给一句说明，不是空文件', () => {
    const md = buildHighlightsMarkdown(doc, [], at);
    expect(md).toContain('（这本书还没有划线或笔记。）');
  });

  it('多行笔记保留换行，标题里的非法字符会被清掉', () => {
    const md = buildHighlightsMarkdown({ title: '' }, [mkHighlight({ noteText: '第一行\n第二行' })], at);
    expect(md).toContain('# 未命名文档');
    expect(md).toContain('第一行  \n第二行');
    expect(sanitize('a/b:c*d?"<>|')).toBe('a b c d');
  });
});

describe('选段气泡定位', () => {
  const box = { anchorX: 400, below: 300, above: 280, width: 300, height: 120, viewportW: 1000, viewportH: 800 };

  it('默认贴在选区下面并水平居中', () => {
    expect(clampPopover(box)).toEqual({ left: 250, top: 308 });
  });

  it('下面放不下就翻到选区上方', () => {
    const pos = clampPopover({ ...box, below: 780, above: 740 });
    expect(pos.top).toBe(740 - 120 - 8);
  });

  it('上下都放不下时也钳在视口里', () => {
    const pos = clampPopover({ ...box, below: 790, above: 10, height: 600 });
    expect(pos.top).toBeGreaterThanOrEqual(8);
    expect(pos.top + 600).toBeLessThanOrEqual(800);
  });

  it('左右都不越界', () => {
    expect(clampPopover({ ...box, anchorX: 0 }).left).toBe(8);
    expect(clampPopover({ ...box, anchorX: 1000 }).left).toBe(1000 - 300 - 8);
  });
});

describe('调色板与阅读主题', () => {
  it('四色可选，未知颜色回落到第一个', () => {
    expect(HIGHLIGHT_COLORS.map((c) => c.key)).toEqual(['yellow', 'green', 'blue', 'pink']);
    expect(colorCss('blue')).toBe('var(--color-highlight-blue)');
    expect(colorCss('不存在')).toBe(colorCss('yellow'));
  });

  it('三个主题都有底色，夜读对画布反色', () => {
    expect(THEME_ORDER).toEqual(['paper', 'night', 'eye']);
    for (const k of THEME_ORDER) expect(READER_THEMES[k].pageBg).toMatch(/^#/);
    expect(READER_THEMES.night.canvasFilter).toContain('invert(1)');
    expect(READER_THEMES.paper.canvasFilter).toBe('none');
  });
});
