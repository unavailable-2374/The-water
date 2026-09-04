import { describe, expect, it } from 'vitest';
import type { Arc } from '@the-water/shared';
import { groupByArc } from '@/novel/storyline/affected';

const arc = (id: string, title: string, startChapterNo: number, endChapterNo: number): Arc => ({ id, title, summary: '', startChapterNo, endChapterNo });
const row = (chapterNo: number) => ({ chapterNo });

describe('按故事弧分组（§2.2 第 5 条）', () => {
  const arcs = [arc('a1', '开篇', 1, 3), arc('a2', '中盘', 4, 6)];

  it('按范围归组，组内按章号排', () => {
    const groups = groupByArc([row(5), row(2), row(1)], arcs);
    expect(groups.map((g) => [g.arcId, g.items.map((i) => i.chapterNo)])).toEqual([
      ['a1', [1, 2]],
      ['a2', [5]],
    ]);
    expect(groups[0]).toMatchObject({ title: '开篇', startChapterNo: 1, endChapterNo: 3 });
  });

  it('不在任何弧里的章节归到最后一组', () => {
    const groups = groupByArc([row(9), row(2)], arcs);
    expect(groups.map((g) => g.arcId)).toEqual(['a1', null]);
    expect(groups[1]).toMatchObject({ title: '未归入故事弧', startChapterNo: null, endChapterNo: null, items: [{ chapterNo: 9 }] });
  });

  it('章节同时落在多个弧里时归最窄的那个', () => {
    const overlapping = [arc('big', '全书', 1, 20), arc('small', '一个小高潮', 5, 6)];
    const groups = groupByArc([row(5), row(10)], overlapping);
    expect(groups.find((g) => g.arcId === 'small')!.items).toEqual([{ chapterNo: 5 }]);
    expect(groups.find((g) => g.arcId === 'big')!.items).toEqual([{ chapterNo: 10 }]);
  });

  it('弧的起止写反了也照样能归组', () => {
    expect(groupByArc([row(4)], [arc('r', '倒着写的', 6, 3)])[0]!.arcId).toBe('r');
  });

  it('组按组内最小章号排序，没有弧的一组永远在最后', () => {
    const groups = groupByArc([row(99), row(5), row(1)], arcs);
    expect(groups.map((g) => g.arcId)).toEqual(['a1', 'a2', null]);
  });

  it('没有弧 / 没有行时的退化情形', () => {
    expect(groupByArc([], arcs)).toEqual([]);
    const all = groupByArc([row(1), row(2)], []);
    expect(all).toHaveLength(1);
    expect(all[0]!.arcId).toBeNull();
  });

  it('弧没有标题时给个占位名，不留空标题', () => {
    expect(groupByArc([row(1)], [arc('x', '', 1, 2)])[0]!.title).toBe('未命名故事弧');
  });

  it('不改输入数组的顺序', () => {
    const items = [row(5), row(1)];
    groupByArc(items, arcs);
    expect(items.map((i) => i.chapterNo)).toEqual([5, 1]);
  });
});
