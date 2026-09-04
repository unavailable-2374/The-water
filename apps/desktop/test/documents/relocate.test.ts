import { describe, expect, it } from 'vitest';
import { buildAnchor, normalizePageText } from '@/pdf/anchor';
import { countMissing, relocateAnchor, relocateHighlights } from '@/documents/relocate';
import { buildTextMap, offsetOfDomPoint, spanToDom, type TextChunk } from '@/documents/domText';

const page = normalizePageText('天地玄黄  宇宙洪荒\n日月盈昃 辰宿列张 寒来暑往 秋收冬藏 宇宙洪荒 闰余成岁');

describe('高亮重定位', () => {
  it('位置没变时报 ok', () => {
    const s = page.indexOf('日月');
    const a = buildAnchor(page, s, s + 4, []);
    expect(relocateAnchor(page, a)).toEqual({ status: 'ok', start: s, end: s + 4 });
  });

  it('文本前面插了内容时报 moved，并给出新位置', () => {
    const s = page.indexOf('日月');
    const a = buildAnchor(page, s, s + 4, []);
    const shifted = '前言。' + page;
    expect(relocateAnchor(shifted, a)).toEqual({ status: 'moved', start: s + 3, end: s + 4 + 3 });
  });

  it('引文没了就报 missing', () => {
    const a = buildAnchor(page, 0, 4, []);
    expect(relocateAnchor('完全不同的一页文字', a)).toEqual({ status: 'missing', start: null, end: null });
  });

  it('这一页还没建索引时报 unknown，按存的矩形先画着', () => {
    const a = buildAnchor(page, 0, 4, []);
    expect(relocateAnchor(null, a)).toEqual({ status: 'unknown', start: 0, end: 4 });
    expect(relocateAnchor('', a).status).toBe('unknown');
  });

  it('空引文直接算 missing', () => {
    expect(relocateAnchor(page, { exact: '', prefix: '', suffix: '', start: null, end: null, rects: [] }).status).toBe('missing');
  });

  it('整本重定位并数出无法定位的条数', () => {
    const s = page.indexOf('日月');
    const ok = { id: 'a', pageNo: 1, anchor: buildAnchor(page, s, s + 4, []) };
    const lost = { id: 'b', pageNo: 1, anchor: buildAnchor(page, 0, 4, []) };
    const later = { id: 'c', pageNo: 2, anchor: buildAnchor(page, 0, 4, []) };
    // 页首插了两个字：ok 的那条位置后移，lost 的那条引文（天地玄黄）被改没了
    const texts = new Map([[1, page.replace('天地玄黄', '天地不仁如此')]]);
    const locs = relocateHighlights([ok, lost, later], texts);
    expect(locs.a!.status).toBe('moved');
    expect(locs.b!.status).toBe('missing');
    expect(locs.c!.status).toBe('unknown');
    expect(countMissing(locs)).toBe(1);
  });
});

describe('文字层 DOM 偏移映射', () => {
  const fakeNode = (text: string) => ({ nodeValue: text, length: text.length }) as unknown as Text;

  it('拼接时折叠空白，并记住每个字的来源', () => {
    const a = fakeNode('天地  玄黄');
    const b = fakeNode(' 宇宙');
    const chunks: TextChunk[] = [{ node: a, text: '天地  玄黄' }, { node: b, text: ' 宇宙' }];
    const map = buildTextMap(chunks);
    expect(map.text).toBe('天地 玄黄 宇宙');
    expect(map.entries).toHaveLength(map.text.length);
    expect(map.entries[0]).toEqual({ chunk: 0, offset: 0 });
    expect(map.entries[map.text.indexOf('宇')]).toEqual({ chunk: 1, offset: 1 });
  });

  it('首尾空白不进正文', () => {
    const map = buildTextMap([{ node: fakeNode('  甲乙  '), text: '  甲乙  ' }]);
    expect(map.text).toBe('甲乙');
  });

  it('换行占位（<br>）折成一个空格，且不作为 range 端点', () => {
    const a = fakeNode('上句');
    const b = fakeNode('下句');
    const map = buildTextMap([{ node: a, text: '上句' }, { node: null, text: '\n' }, { node: b, text: '下句' }]);
    expect(map.text).toBe('上句 下句');
    const span = spanToDom(map, 2, 4)!;
    expect(span.startNode).toBe(b);
    expect(span.startOffset).toBe(0);
    expect(span.endNode).toBe(b);
  });

  it('偏移换成 DOM 位置，再换回来是同一段', () => {
    const a = fakeNode('天地玄黄');
    const map = buildTextMap([{ node: a, text: '天地玄黄' }]);
    const span = spanToDom(map, 1, 3)!;
    expect([span.startOffset, span.endOffset]).toEqual([1, 3]);
    expect(offsetOfDomPoint(map, a, 1, 'start')).toBe(1);
    expect(offsetOfDomPoint(map, a, 3, 'end')).toBe(3);
  });

  it('越界或空区间返回 null', () => {
    const map = buildTextMap([{ node: fakeNode('甲乙'), text: '甲乙' }]);
    expect(spanToDom(map, 1, 1)).toBeNull();
    expect(spanToDom(map, 0, 99)).toBeNull();
    expect(offsetOfDomPoint(map, fakeNode('别的'), 0, 'start')).toBe(-1);
  });
});
