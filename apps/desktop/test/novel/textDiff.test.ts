import { describe, expect, it } from 'vitest';
import {
  diffSegments, diffStats, diffText, refineOps, sideOf, splitLines, splitSentences, summarizeTextDiff, type DiffOp,
} from '@/novel/diff';

const oldSide = (ops: readonly DiffOp[]) => sideOf(ops, 'old').map((o) => o.text).join('');
const newSide = (ops: readonly DiffOp[]) => sideOf(ops, 'new').map((o) => o.text).join('');
const shape = (ops: readonly DiffOp[]) => ops.map((o) => `${o.type[0]}:${o.text}`);

describe('切分是无损的', () => {
  const samples = ['', '一句话', '第一段\n第二段', '开头。中间！结尾？\n下一段。', '他说：「走。」然后走了。', '结尾没有标点', '空行\n\n后面'];
  it('行切分拼回原文', () => {
    for (const s of samples) expect(splitLines(s).join('')).toBe(s);
  });
  it('句切分拼回原文', () => {
    for (const s of samples) expect(splitSentences(s).join('')).toBe(s);
  });
  it('换行留在行末，句末标点与紧随的换行留在句末', () => {
    expect(splitLines('甲\n乙')).toEqual(['甲\n', '乙']);
    expect(splitSentences('走了。回来了！')).toEqual(['走了。', '回来了！']);
    expect(splitSentences('走了。\n回来了')).toEqual(['走了。\n', '回来了']);
    expect(splitSentences('他说：「走。」然后走了。')).toEqual(['他说：「走。」', '然后走了。']);
  });
});

describe('diffSegments', () => {
  it('完全相同只有一段 equal', () => {
    expect(shape(diffSegments(['甲', '乙'], ['甲', '乙']))).toEqual(['e:甲乙']);
  });
  it('剥掉公共前后缀，只标中间那段', () => {
    expect(shape(diffSegments(['甲', '乙', '丙'], ['甲', '丁', '丙']))).toEqual(['e:甲', 'd:乙', 'i:丁', 'e:丙']);
  });
  it('纯新增 / 纯删除', () => {
    expect(shape(diffSegments(['甲'], ['甲', '乙']))).toEqual(['e:甲', 'i:乙']);
    expect(shape(diffSegments(['甲', '乙'], ['甲']))).toEqual(['e:甲', 'd:乙']);
    expect(shape(diffSegments([], ['甲']))).toEqual(['i:甲']);
    expect(shape(diffSegments(['甲'], []))).toEqual(['d:甲']);
    expect(diffSegments([], [])).toEqual([]);
  });
  it('中间插入时保住两侧的公共片段', () => {
    expect(shape(diffSegments(['a', 'b', 'c'], ['a', 'x', 'b', 'c']))).toEqual(['e:a', 'i:x', 'e:bc']);
  });
  it('乱序改动后两侧仍能拼回原文', () => {
    const a = ['一', '二', '三', '四', '五'];
    const b = ['一', '三', '贰', '四', '五', '六'];
    const ops = diffSegments(a, b);
    expect(oldSide(ops)).toBe(a.join(''));
    expect(newSide(ops)).toBe(b.join(''));
  });
});

describe('diffText 两级 LCS', () => {
  it('行级改动会下钻到句级，只标真正改掉的那句', () => {
    const oldText = '他推开门。屋里没有人。\n第二段照旧。';
    const newText = '他推开门。屋里坐着一个人。\n第二段照旧。';
    const ops = diffText(oldText, newText);
    // 句末标点后面紧跟的换行归在这一句里，所以 delete / insert 段带着 '\n'
    expect(ops.some((o) => o.type === 'delete' && o.text === '屋里没有人。\n')).toBe(true);
    expect(ops.some((o) => o.type === 'insert' && o.text === '屋里坐着一个人。\n')).toBe(true);
    // 没改的那句留在 equal 里，不会被整段标成删除
    expect(ops.some((o) => o.type === 'equal' && o.text.includes('他推开门。'))).toBe(true);
  });
  it('关掉下钻就退回行级', () => {
    const oldText = '他推开门。屋里没有人。';
    const newText = '他推开门。屋里坐着一个人。';
    const ops = diffText(oldText, newText, { refine: false });
    expect(shape(ops)).toEqual(['d:他推开门。屋里没有人。', 'i:他推开门。屋里坐着一个人。']);
  });
  it('句级粒度可以直接指定', () => {
    const ops = diffText('甲。乙。丙。', '甲。丁。丙。', { granularity: 'sentence' });
    expect(shape(ops)).toEqual(['e:甲。', 'd:乙。', 'i:丁。', 'e:丙。']);
  });
  it('两边拼回来必须等于原文（含多段改动）', () => {
    const oldText = '第一段第一句。第一段第二句。\n\n第二段。\n第三段整段要删。';
    const newText = '第一段第一句。第一段改过的第二句。\n\n第二段。\n新加的一段。';
    const ops = diffText(oldText, newText);
    expect(oldSide(ops)).toBe(oldText);
    expect(newSide(ops)).toBe(newText);
  });
  it('完全一样 / 全空', () => {
    expect(diffText('一样', '一样')).toEqual([{ type: 'equal', text: '一样' }]);
    expect(diffText('', '')).toEqual([]);
    expect(shape(diffText('', '新写的'))).toEqual(['i:新写的']);
  });
  it('整章重写也能拼回两侧', () => {
    const oldText = Array.from({ length: 60 }, (_, i) => `旧文第${i}段。里面有两句。`).join('\n');
    const newText = Array.from({ length: 60 }, (_, i) => `新文第${i}段。换了写法。`).join('\n');
    const ops = diffText(oldText, newText);
    expect(oldSide(ops)).toBe(oldText);
    expect(newSide(ops)).toBe(newText);
  });
});

describe('refineOps', () => {
  it('删在前加在后、加在前删在后都能对齐', () => {
    const a: DiffOp[] = [{ type: 'delete', text: '甲。乙。' }, { type: 'insert', text: '甲。丙。' }];
    const b: DiffOp[] = [{ type: 'insert', text: '甲。丙。' }, { type: 'delete', text: '甲。乙。' }];
    expect(shape(refineOps(a))).toEqual(['e:甲。', 'd:乙。', 'i:丙。']);
    expect(shape(refineOps(b))).toEqual(['e:甲。', 'd:乙。', 'i:丙。']);
  });
  it('孤立的删或加原样保留', () => {
    expect(shape(refineOps([{ type: 'delete', text: '甲。' }]))).toEqual(['d:甲。']);
  });
});

describe('统计与摘要', () => {
  it('按字符数统计，连续的删加算一处改动', () => {
    const ops = diffText('甲。乙。丙。', '甲。丁丁。丙。', { granularity: 'sentence' });
    const s = diffStats(ops);
    expect(s).toMatchObject({ added: 3, removed: 2, unchanged: 4, blocks: 1 });
  });
  it('摘要是人话', () => {
    expect(summarizeTextDiff(diffText('一样', '一样'))).toBe('两稿正文完全一样');
    expect(summarizeTextDiff(diffText('甲。乙。', '甲。丁。', { granularity: 'sentence' }))).toBe('新增 2 字 · 删除 2 字 · 共 1 处改动');
    expect(summarizeTextDiff(diffText('甲。', '甲。乙。', { granularity: 'sentence' }))).toBe('新增 2 字 · 共 1 处改动');
  });
});
