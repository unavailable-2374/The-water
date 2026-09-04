import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  dirOf,
  epubDocumentSource,
  fragmentOf,
  normalizeZipPath,
  opfPathFromContainer,
  parseEpub,
  parseNavToc,
  parseNcxToc,
  parseOpf,
  resolveHref,
} from '@/documents/epubSource';
import { decodeEntities, parseAttrs, sliceElement, xhtmlToBlocks } from '@/documents/xhtml';
import { isReadable, kindFromPath, storageDirFor, storageExtension } from '@/documents/kind';
import { filterImportable } from '@/documents/import';
import { UnsupportedDocumentError } from '@/documents/types';

/** 现场合成一个 EPUB，不依赖任何外部样本文件。 */
function makeEpub(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = { mimetype: strToU8('application/epub+zip') };
  for (const [name, text] of Object.entries(files)) entries[name] = strToU8(text);
  return zipSync(entries, { level: 6 });
}

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

/** 一段够长的正文，保证一章能撑出好几页（CHARS_PER_PAGE = 1000）。 */
const LONG_1 = '乃粒第一，天覆地载，物号数万。'.repeat(60);
const LONG_2 = '作咸第二，口之于味，辛酸甘苦。'.repeat(60);

const CH1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>忽略我</title>
<style>p { color: red }</style><script>var x = 1;</script></head>
<body>
  <h1 id="c1">第一章 起</h1>
  <p>${LONG_1}</p>
  <blockquote>引一句 &amp; 带实体 &#x4e00;</blockquote>
  <ul><li>列表项一</li><li>列表项二</li></ul>
  <p id="mid">${LONG_1}</p>
</body></html>`;

const CH2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
  <h1 id="c2">第二章 承</h1>
  <h2 id="c2s1">第一节</h2>
  <p>${LONG_2}</p>
  <pre>const a = 1;
const b = 2;</pre>
</body></html>`;

const OPF3 = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>天工开物</dc:title>
    <dc:creator>宋应星</dc:creator>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;

const NAV = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<nav epub:type="toc"><ol>
  <li><a href="ch1.xhtml#c1">第一章 起</a></li>
  <li><a href="ch2.xhtml#c2">第二章 承</a>
    <ol><li><a href="ch2.xhtml#c2s1">第一节</a></li></ol>
  </li>
</ol></nav></body></html>`;

function epub3(): Uint8Array {
  return makeEpub({
    'META-INF/container.xml': CONTAINER,
    'OEBPS/content.opf': OPF3,
    'OEBPS/nav.xhtml': NAV,
    'OEBPS/ch1.xhtml': CH1,
    'OEBPS/ch2.xhtml': CH2,
    'OEBPS/style.css': 'p { margin: 0 }',
  });
}

describe('XHTML 扫描', () => {
  it('解实体；认不出的原样留着，不吞字', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#x4e00; &#20108; &unknown;')).toBe('a & b <c> \u4e00 \u4e8c &unknown;');
    // &nbsp; 保留成不换行空格，后面 xhtmlToBlocks 的空白折叠会把它并成普通空格
    expect(decodeEntities('x&nbsp;y')).toBe('x\u00a0y');
    expect(xhtmlToBlocks('<p>x&nbsp;&nbsp;y</p>').blocks).toEqual([{ type: 'p', text: 'x y' }]);
  });

  it('解属性，名字统一小写', () => {
    expect(parseAttrs(` ID="a" HREF='b.xhtml#f' media-type="x/y" bare=z`)).toEqual({
      id: 'a', href: 'b.xhtml#f', 'media-type': 'x/y', bare: 'z',
    });
  });

  it('按同名标签配对取内层，允许嵌套', () => {
    const got = sliceElement('<x><nav id="a"><nav>内</nav>外</nav></x>', 'nav');
    expect(got?.attrs.id).toBe('a');
    expect(got?.inner).toBe('<nav>内</nav>外');
  });

  it('把 XHTML 压成排版块：认标题 / 引用 / 列表 / 代码，剥掉其余标签', () => {
    const { blocks } = xhtmlToBlocks(
      '<html><head><title>丢掉</title><script>丢掉</script></head><body>' +
      '<h1>标题</h1><p>正文 <em>强调</em> 与 <a href="#x">链接</a></p>' +
      '<blockquote><p>引用</p></blockquote><ul><li>项一</li></ul>' +
      '<h5>五级标题</h5><pre>a\nb</pre></body></html>',
    );
    expect(blocks).toEqual([
      { type: 'h1', text: '标题' },
      { type: 'p', text: '正文 强调 与 链接' },
      { type: 'quote', text: '引用' },
      { type: 'li', text: '项一' },
      { type: 'h3', text: '五级标题' },
      { type: 'code', text: 'a\nb' },
    ]);
  });

  it('记下 id → 块下标，供目录锚点定位', () => {
    const { anchors } = xhtmlToBlocks('<body><p id="a">一</p><p>二</p><h2 id="b">三</h2></body>');
    expect(anchors.get('a')).toBe(0);
    expect(anchors.get('b')).toBe(2);
  });
});

describe('EPUB 结构解析', () => {
  it('路径归一与锚点', () => {
    expect(normalizeZipPath('OEBPS/./a/../ch1.xhtml')).toBe('OEBPS/ch1.xhtml');
    expect(dirOf('OEBPS/ch1.xhtml')).toBe('OEBPS');
    expect(resolveHref('OEBPS/text', '../images/../ch1.xhtml#f')).toBe('OEBPS/ch1.xhtml');
    expect(resolveHref('OEBPS', '%E4%B8%80.xhtml')).toBe('OEBPS/一.xhtml');
    expect(fragmentOf('a.xhtml#c2s1')).toBe('c2s1');
    expect(fragmentOf('a.xhtml')).toBeNull();
  });

  it('从 container.xml 取 OPF 路径', () => {
    expect(opfPathFromContainer(CONTAINER)).toBe('OEBPS/content.opf');
    expect(opfPathFromContainer('<container/>')).toBeNull();
  });

  it('解析 OPF 的 metadata / manifest / spine', () => {
    const opf = parseOpf(OPF3);
    expect(opf.meta).toEqual({ title: '天工开物', author: '宋应星', language: 'zh-CN' });
    expect(opf.spine).toEqual(['c1', 'c2']);
    expect(opf.manifest.get('nav')?.properties).toBe('nav');
    expect(opf.manifest.get('c2')?.href).toBe('ch2.xhtml');
  });

  it('spine 里 linear="no" 的条目不进正文', () => {
    const opf = parseOpf(OPF3.replace('<itemref idref="c2"/>', '<itemref idref="c2" linear="no"/>'));
    expect(opf.spine).toEqual(['c1']);
  });

  it('nav.xhtml 的层级来自 ol 嵌套', () => {
    expect(parseNavToc(NAV)).toEqual([
      { title: '第一章 起', href: 'ch1.xhtml#c1', level: 1 },
      { title: '第二章 承', href: 'ch2.xhtml#c2', level: 1 },
      { title: '第一节', href: 'ch2.xhtml#c2s1', level: 2 },
    ]);
  });

  it('toc.ncx 的层级来自 navPoint 嵌套', () => {
    const ncx = `<ncx><navMap>
      <navPoint id="n1"><navLabel><text>第一章 起</text></navLabel><content src="ch1.xhtml"/>
        <navPoint id="n1a"><navLabel><text>小节</text></navLabel><content src="ch1.xhtml#mid"/></navPoint>
      </navPoint>
      <navPoint id="n2"><navLabel><text>第二章 承</text></navLabel><content src="ch2.xhtml"/></navPoint>
    </navMap></ncx>`;
    expect(parseNcxToc(ncx)).toEqual([
      { title: '第一章 起', href: 'ch1.xhtml', level: 1 },
      { title: '小节', href: 'ch1.xhtml#mid', level: 2 },
      { title: '第二章 承', href: 'ch2.xhtml', level: 1 },
    ]);
  });
});

describe('EPUB 文档源', () => {
  it('实现了统一的文档源接口', async () => {
    const src = epubDocumentSource(epub3());
    expect(src.kind).toBe('epub');
    expect(src.renderMode).toBe('text');
    expect(src.numPages).toBeGreaterThan(2);
    expect(await src.pageSize(1)).toEqual({ width: 720, height: 1040 });
    expect((await src.probeTextLayer()).hasText).toBe(true);
    expect(src.meta).toEqual({ title: '天工开物', author: '宋应星', language: 'zh-CN' });
    await src.close();
  });

  it('第一页是第一章标题，正文与目录都对得上', async () => {
    const src = epubDocumentSource(epub3());
    expect(src.pageBlocks(1)[0]).toEqual({ type: 'h1', text: '第一章 起' });
    expect(await src.pageText(1)).toContain('乃粒第一');

    const outline = await src.getOutline();
    expect(outline.map((n) => n.title)).toEqual(['第一章 起', '第二章 承']);
    expect(outline[0]!.pageNo).toBe(1);
    expect(outline[1]!.children.map((c) => c.title)).toEqual(['第一节']);

    // 第二章从新的一页开始，且那一页的第一块就是它的标题
    const ch2Page = outline[1]!.pageNo!;
    expect(ch2Page).toBeGreaterThan(1);
    expect(src.pageBlocks(ch2Page)[0]).toEqual({ type: 'h1', text: '第二章 承' });
    expect(await src.pageText(ch2Page)).toContain('第二章 承');
    // 第一章的内容不该漏进第二章的首页
    expect(await src.pageText(ch2Page)).not.toContain('乃粒第一');
  });

  it('每一页都拿得到文字，页码越界不炸', async () => {
    const src = epubDocumentSource(epub3());
    for (let i = 1; i <= src.numPages; i += 1) expect((await src.pageText(i)).length).toBeGreaterThan(0);
    expect(await src.pageText(0)).toBe('');
    expect(await src.pageText(src.numPages + 99)).toBe('');
    expect(src.pageBlocks(src.numPages + 99)).toEqual([]);
  });

  it('实体、引用、列表与代码块都保留了下来', async () => {
    const book = parseEpub(epub3());
    const all = book.pages.flat();
    expect(all).toContainEqual({ type: 'quote', text: '引一句 & 带实体 一' });
    expect(all).toContainEqual({ type: 'li', text: '列表项一' });
    expect(all).toContainEqual({ type: 'code', text: 'const a = 1;\nconst b = 2;' });
  });

  it('没有 nav 时退回 toc.ncx', async () => {
    const opf2 = OPF3
      .replace('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
        '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>')
      .replace('<spine>', '<spine toc="ncx">');
    const bytes = makeEpub({
      'META-INF/container.xml': CONTAINER,
      'OEBPS/content.opf': opf2,
      'OEBPS/toc.ncx': `<ncx><navMap>
        <navPoint><navLabel><text>起</text></navLabel><content src="ch1.xhtml"/></navPoint>
        <navPoint><navLabel><text>承</text></navLabel><content src="ch2.xhtml"/></navPoint>
      </navMap></ncx>`,
      'OEBPS/ch1.xhtml': CH1,
      'OEBPS/ch2.xhtml': CH2,
    });
    const src = epubDocumentSource(bytes);
    const outline = await src.getOutline();
    expect(outline.map((n) => n.title)).toEqual(['起', '承']);
    expect(outline[1]!.pageNo).toBeGreaterThan(1);
  });

  it('整本一个文件时，目录的 #锚点 也能落到对应的页', async () => {
    const single = `<html><body><h1 id="a">卷一</h1><p>${LONG_1}</p><p>${LONG_1}</p><h1 id="b">卷二</h1><p>${LONG_2}</p></body></html>`;
    const opf = OPF3
      .replace('<item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>', '')
      .replace('<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>', '<item id="c1" href="book.xhtml" media-type="application/xhtml+xml"/>')
      .replace('<itemref idref="c2"/>', '');
    const bytes = makeEpub({
      'META-INF/container.xml': CONTAINER,
      'OEBPS/content.opf': opf,
      'OEBPS/nav.xhtml': `<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>
        <li><a href="book.xhtml#a">卷一</a></li><li><a href="book.xhtml#b">卷二</a></li>
      </ol></nav></body></html>`,
      'OEBPS/book.xhtml': single,
    });
    const outline = await epubDocumentSource(bytes).getOutline();
    expect(outline.map((n) => n.title)).toEqual(['卷一', '卷二']);
    expect(outline[0]!.pageNo).toBe(1);
    expect(outline[1]!.pageNo).toBeGreaterThan(1);
  });

  it('没有目录时退回按正文标题生成目录', async () => {
    const bytes = makeEpub({
      'META-INF/container.xml': CONTAINER,
      'OEBPS/content.opf': OPF3.replace('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>', ''),
      'OEBPS/ch1.xhtml': CH1,
      'OEBPS/ch2.xhtml': CH2,
    });
    const outline = await epubDocumentSource(bytes).getOutline();
    expect(outline.map((n) => n.title)).toEqual(['第一章 起', '第二章 承']);
    expect(outline[1]!.children.map((c) => c.title)).toEqual(['第一节']);
  });

  it('缺 container.xml 时按扩展名找 OPF', () => {
    const bytes = makeEpub({ 'OEBPS/content.opf': OPF3, 'OEBPS/nav.xhtml': NAV, 'OEBPS/ch1.xhtml': CH1, 'OEBPS/ch2.xhtml': CH2 });
    expect(parseEpub(bytes).meta.title).toBe('天工开物');
  });

  it('坏文件与空书都给明确错误，不白屏', () => {
    expect(() => parseEpub(new Uint8Array([1, 2, 3, 4]))).toThrow(UnsupportedDocumentError);
    const empty = makeEpub({
      'META-INF/container.xml': CONTAINER,
      'OEBPS/content.opf': OPF3.replace('<itemref idref="c1"/>', '').replace('<itemref idref="c2"/>', ''),
      'OEBPS/nav.xhtml': NAV,
    });
    expect(() => parseEpub(empty)).toThrow(UnsupportedDocumentError);
    const noOpf = makeEpub({ 'a.txt': 'x' });
    expect(() => parseEpub(noOpf)).toThrow(/找不到 OPF/);
  });
});

describe('EPUB 已接进导入链路', () => {
  it('认得出、算得上「能读」、存到 docs 目录', () => {
    expect(kindFromPath('/x/书.EPUB')).toBe('epub');
    expect(isReadable('a.epub')).toBe(true);
    expect(storageDirFor('epub')).toBe('docs');
    expect(storageExtension('epub')).toBe('epub');
  });

  it('拖拽时不再被拒', () => {
    const { accepted, rejected } = filterImportable(['a.pdf', 'b.epub', 'c.md', 'd.zip']);
    expect(accepted).toEqual(['a.pdf', 'b.epub', 'c.md']);
    expect(rejected).toEqual(['d.zip']);
  });
});
