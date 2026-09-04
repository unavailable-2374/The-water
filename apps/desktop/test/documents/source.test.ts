import { describe, expect, it } from 'vitest';
import { extensionOf, isReadable, kindFromPath, storageDirFor, storageExtension, titleFromPath } from '@/documents/kind';
import { inlineText, outlineFromPages, pageTextOf, paginateBlocks, parseBlocks, splitLongBlock } from '@/documents/textPaginate';
import { TEXT_PAGE_SIZE, nestOutline, textDocumentSource } from '@/documents/textSource';
import { assessTextLayer } from '@/documents/pdfSource';
import { decodeText } from '@/documents/open';
import { filterImportable } from '@/documents/import';
import type { TextBlock } from '@/documents/types';

describe('文档类型识别', () => {
  it('按扩展名分派', () => {
    expect(kindFromPath('/a/b/书.pdf')).toBe('pdf');
    expect(kindFromPath('C:\\书\\note.MD')).toBe('md');
    expect(kindFromPath('x.markdown')).toBe('md');
    expect(kindFromPath('x.txt')).toBe('txt');
    expect(kindFromPath('x.epub')).toBe('epub');
    expect(kindFromPath('x.docx')).toBeNull();
    expect(kindFromPath('没有扩展名')).toBeNull();
  });

  it('只有 pdf/txt/md 算「现在能读」', () => {
    expect(isReadable('a.pdf')).toBe(true);
    expect(isReadable('a.md')).toBe(true);
    expect(isReadable('a.epub')).toBe(false);
  });

  it('存盘目录与扩展名', () => {
    expect(storageDirFor('pdf')).toBe('pdfs');
    expect(storageDirFor('txt')).toBe('docs');
    expect(storageExtension('md')).toBe('md');
    expect(extensionOf('a/b.c.TXT')).toBe('txt');
    expect(titleFromPath('/x/天工开物.pdf')).toBe('天工开物');
  });

  it('拖拽时挑得出能导入的文件', () => {
    const { accepted, rejected } = filterImportable(['a.pdf', 'b.epub', 'c.md', 'd.zip']);
    expect(accepted).toEqual(['a.pdf', 'c.md']);
    expect(rejected).toEqual(['b.epub', 'd.zip']);
  });
});

describe('文本分块与分页', () => {
  it('txt 按空行分段', () => {
    const blocks = parseBlocks('第一段\n还是第一段\n\n第二段', 'txt');
    expect(blocks).toEqual([
      { type: 'p', text: '第一段 还是第一段' },
      { type: 'p', text: '第二段' },
    ]);
  });

  it('md 认得标题、引用、列表与围栏代码', () => {
    const md = ['# 标题', '', '> 引用一句', '- 列表项', '', '```js', 'const a = 1;', '```', '正文 **加粗** 与 [链接](http://x)'].join('\n');
    expect(parseBlocks(md, 'md')).toEqual([
      { type: 'h1', text: '标题' },
      { type: 'quote', text: '引用一句' },
      { type: 'li', text: '列表项' },
      { type: 'code', text: 'const a = 1;' },
      { type: 'p', text: '正文 加粗 与 链接' },
    ]);
  });

  it('行内记号只留可读文字', () => {
    expect(inlineText('`code` *斜* ~~删~~ ![图](a.png)')).toBe('code 斜 删 图');
  });

  it('超长段落切开，每片都不超过上限', () => {
    const long = '句子。'.repeat(50);
    const pieces = splitLongBlock({ type: 'p', text: long }, 30);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(p.text.length).toBeLessThanOrEqual(30);
    expect(pieces.map((p) => p.text).join('')).toBe(long);
  });

  it('分页不丢字，且标题不落在页尾', () => {
    const blocks: TextBlock[] = [
      { type: 'p', text: 'a'.repeat(80) },
      { type: 'h2', text: '第二章' },
      { type: 'p', text: 'b'.repeat(80) },
    ];
    const pages = paginateBlocks(blocks, 100);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.map((p) => pageTextOf(p)).join('\n').replace(/\n/g, '')).toBe('a'.repeat(80) + '第二章' + 'b'.repeat(80));
    expect(pages[0]!.some((b) => b.type === 'h2')).toBe(false);
  });

  it('空文档也有一页', () => {
    expect(paginateBlocks([], 100)).toEqual([[]]);
  });

  it('目录从标题里抽，并按层级折成树', () => {
    const pages = [[{ type: 'h1', text: '卷一' } as TextBlock], [{ type: 'h2', text: '第一章' } as TextBlock, { type: 'h2', text: '第二章' } as TextBlock]];
    const flat = outlineFromPages(pages);
    expect(flat).toEqual([
      { title: '卷一', pageNo: 1, level: 1 },
      { title: '第一章', pageNo: 2, level: 2 },
      { title: '第二章', pageNo: 2, level: 2 },
    ]);
    const tree = nestOutline(flat);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children.map((c) => c.title)).toEqual(['第一章', '第二章']);
  });
});

describe('文本文档源', () => {
  const md = ['# 天工开物', '', '乃粒第一。'.repeat(300), '', '## 卷二', '', '作咸第二。'.repeat(300)].join('\n');

  it('实现了统一的文档源接口', async () => {
    const src = textDocumentSource(md, 'md');
    expect(src.kind).toBe('md');
    expect(src.renderMode).toBe('text');
    expect(src.numPages).toBeGreaterThan(1);
    expect(await src.pageSize(1)).toEqual(TEXT_PAGE_SIZE);
    expect(await src.pageText(1)).toContain('天工开物');
    expect((await src.getOutline())[0]!.title).toBe('天工开物');
    expect((await src.probeTextLayer()).hasText).toBe(true);
    await src.close();
  });

  it('页码越界时不炸', async () => {
    const src = textDocumentSource('只有一点点内容', 'txt');
    expect(await src.pageText(99)).toBe('');
    expect(src.pageBlocks(99)).toEqual([]);
  });
});

describe('扫描版判定与编码', () => {
  it('抽样字符太少就判为没有文字层', () => {
    expect(assessTextLayer(0, 6)).toEqual({ hasText: false, sampledPages: 6, avgChars: 0 });
    expect(assessTextLayer(30, 6).hasText).toBe(false);
    expect(assessTextLayer(6000, 6).hasText).toBe(true);
    expect(assessTextLayer(10, 0)).toEqual({ hasText: false, sampledPages: 0, avgChars: 0 });
  });

  it('UTF-8 正常解码', () => {
    expect(decodeText(new TextEncoder().encode('天地玄黄'))).toBe('天地玄黄');
  });
});
