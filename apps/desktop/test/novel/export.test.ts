import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import {
  buildDocx, buildEpub, buildExportBytes, buildMarkdown, buildTxt, chapterHeading, exportFileName,
  safeFileName, selectChapters, type ExportChapter, type ExportMeta,
} from '@/novel/export';

const chapters: ExportChapter[] = [
  { chapterNo: 1, title: '起', content: '第一段。\n\n第二段 <带尖括号> 与 & 符号。' },
  { chapterNo: 2, title: '承', content: '承的正文。' },
  { chapterNo: 3, title: '转', content: '转的正文。' },
];
const meta: ExportMeta = {
  title: '青山记',
  author: '张三',
  description: '一个关于山的故事',
  license: 'CC BY-NC 4.0',
  language: 'zh-CN',
  identifier: 'urn:the-water:novel:abc',
  date: new Date('2026-09-04T10:00:00Z'),
};

const text = (u: Uint8Array): string => new TextDecoder().decode(u);

describe('章节范围', () => {
  it('闭区间选择，两端可省略', () => {
    expect(selectChapters(chapters, { from: 2, to: 3 }).map((c) => c.chapterNo)).toEqual([2, 3]);
    expect(selectChapters(chapters, { from: 2 }).map((c) => c.chapterNo)).toEqual([2, 3]);
    expect(selectChapters(chapters, { to: 1 }).map((c) => c.chapterNo)).toEqual([1]);
    expect(selectChapters(chapters, null).map((c) => c.chapterNo)).toEqual([1, 2, 3]);
    expect(selectChapters(chapters, { from: 9, to: 10 })).toEqual([]);
  });
  it('无论输入顺序都按章号升序', () => {
    expect(selectChapters([chapters[2]!, chapters[0]!], null).map((c) => c.chapterNo)).toEqual([1, 3]);
  });
  it('标题为空时不留多余空格', () => {
    expect(chapterHeading({ chapterNo: 4, title: '', content: '' })).toBe('第4章');
    expect(chapterHeading(chapters[0]!)).toBe('第1章 起');
  });
});

describe('文件名', () => {
  it('去掉非法字符，范围写进名字里', () => {
    expect(safeFileName('a/b:c*d')).toBe('a_b_c_d');
    expect(safeFileName('   ')).toBe('小说');
    expect(exportFileName(meta, 'epub', null)).toBe('青山记.epub');
    expect(exportFileName(meta, 'txt', { from: 2, to: 3 })).toBe('青山记（第2-3章）.txt');
    expect(exportFileName(meta, 'md', { from: 2 })).toBe('青山记（第2-末章）.md');
  });
});

describe('TXT / Markdown', () => {
  it('TXT 带元数据抬头与章节标题', () => {
    const s = buildTxt(chapters, meta);
    expect(s).toContain('《青山记》');
    expect(s).toContain('作者：张三');
    expect(s).toContain('简介：一个关于山的故事');
    expect(s).toContain('许可：CC BY-NC 4.0');
    expect(s).toContain('第1章 起');
    expect(s).toContain('第二段 <带尖括号> 与 & 符号。');
  });
  it('Markdown 有 YAML 前置元数据与二级标题', () => {
    const s = buildMarkdown(chapters, meta);
    expect(s.startsWith('---\n')).toBe(true);
    expect(s).toContain('title: "青山记"');
    expect(s).toContain('author: "张三"');
    expect(s).toContain('license: "CC BY-NC 4.0"');
    expect(s).toContain('# 青山记');
    expect(s).toContain('## 第2章 承');
  });
  it('buildExportBytes 与文本构建一致', () => {
    expect(text(buildExportBytes('md', chapters, meta))).toBe(buildMarkdown(chapters, meta));
    expect(text(buildExportBytes('txt', chapters, meta))).toBe(buildTxt(chapters, meta));
  });
});

describe('EPUB', () => {
  const bytes = buildEpub(chapters, meta);
  const files = unzipSync(bytes);

  it('包含 EPUB 3 必需条目', () => {
    for (const name of ['mimetype', 'META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml', 'OEBPS/toc.ncx', 'OEBPS/titlepage.xhtml']) {
      expect(Object.keys(files)).toContain(name);
    }
    expect(text(files['mimetype']!)).toBe('application/epub+zip');
  });

  it('mimetype 是第一个条目且未压缩', () => {
    // 本地文件头：0..3 签名，8..9 压缩方式，26..27 文件名长度
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(bytes[8]! | (bytes[9]! << 8)).toBe(0);
    const nameLen = bytes[26]! | (bytes[27]! << 8);
    expect(text(bytes.slice(30, 30 + nameLen))).toBe('mimetype');
  });

  it('每章一个 xhtml，正文分段并转义', () => {
    expect(Object.keys(files).filter((k) => k.startsWith('OEBPS/chapter-'))).toHaveLength(3);
    const ch1 = text(files['OEBPS/chapter-0001.xhtml']!);
    expect(ch1).toContain('<h1>第1章 起</h1>');
    expect(ch1).toContain('<p>第一段。</p>');
    expect(ch1).toContain('&lt;带尖括号&gt;');
    expect(ch1).toContain('&amp;');
  });

  it('opf 里带齐元数据，spine 覆盖全部章节', () => {
    const opf = text(files['OEBPS/content.opf']!);
    expect(opf).toContain('<dc:title>青山记</dc:title>');
    expect(opf).toContain('<dc:creator>张三</dc:creator>');
    expect(opf).toContain('<dc:description>一个关于山的故事</dc:description>');
    expect(opf).toContain('<dc:rights>CC BY-NC 4.0</dc:rights>');
    expect(opf).toContain('<dc:identifier id="bookid">urn:the-water:novel:abc</dc:identifier>');
    expect(opf).toContain('<meta property="dcterms:modified">2026-09-04T10:00:00Z</meta>');
    expect(opf).toContain('<itemref idref="ch3"/>');
    const nav = text(files['OEBPS/nav.xhtml']!);
    expect(nav).toContain('第3章 转');
    expect(text(files['OEBPS/toc.ncx']!)).toContain('<text>第2章 承</text>');
  });

  it('只导出一段范围时目录也只有那几章', () => {
    const part = unzipSync(buildEpub(selectChapters(chapters, { from: 2, to: 3 }), meta));
    expect(Object.keys(part).filter((k) => k.startsWith('OEBPS/chapter-'))).toHaveLength(2);
    expect(text(part['OEBPS/chapter-0001.xhtml']!)).toContain('第2章 承');
  });
});

describe('DOCX', () => {
  const files = unzipSync(buildDocx(chapters, meta));

  it('包含 OOXML 必需条目', () => {
    for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml']) {
      expect(Object.keys(files)).toContain(name);
    }
  });

  it('正文有标题段与每章标题', () => {
    const doc = text(files['word/document.xml']!);
    expect(doc).toContain('<w:pStyle w:val="Title"/>');
    expect(doc).toContain('青山记');
    expect(doc).toContain('第1章 起');
    expect(doc).toContain('第3章 转');
    expect(doc).toContain('&lt;带尖括号&gt;');
    // 三章标题 + 正文段落
    expect(doc.match(/<w:pStyle w:val="Heading1"\/>/g)).toHaveLength(3);
  });

  it('文档属性带书名、作者、简介、许可', () => {
    const core = text(files['docProps/core.xml']!);
    expect(core).toContain('<dc:title>青山记</dc:title>');
    expect(core).toContain('<dc:creator>张三</dc:creator>');
    expect(core).toContain('<dc:description>一个关于山的故事</dc:description>');
    expect(core).toContain('<cp:keywords>CC BY-NC 4.0</cp:keywords>');
  });

  it('buildExportBytes 走的是同一套产物', () => {
    expect(Object.keys(unzipSync(buildExportBytes('docx', chapters, meta)))).toEqual(Object.keys(files));
    expect(Object.keys(unzipSync(buildExportBytes('epub', chapters, meta)))).toContain('mimetype');
  });
});
