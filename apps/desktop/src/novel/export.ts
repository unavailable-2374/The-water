import { zipSync, type Zippable } from 'fflate';
import { listCurrentVersions } from '@/db/repos/chaptersRepo';
import type { Novel } from '@/db/repos/novelsRepo';

export type ExportFormat = 'txt' | 'md' | 'epub' | 'docx';

/** 导出用的一章：只要章号、标题、正文。纯函数层不认识数据库。 */
export interface ExportChapter {
  chapterNo: number;
  title: string;
  content: string;
}

/** 随书写进文件的元数据。 */
export interface ExportMeta {
  title: string;
  author: string;
  description: string;
  license: string;
  /** BCP-47 语言标记，EPUB / DOCX 用得上。 */
  language?: string;
  /** 稳定标识符，缺省时按书名生成；EPUB 的 dc:identifier 需要它。 */
  identifier?: string;
  /** 生成时间，测试里可固定。 */
  date?: Date;
}

/** 章节范围（闭区间，按章号）。两端都可省略，表示不设限。 */
export interface ExportRange {
  from?: number | null;
  to?: number | null;
}

export const FORMAT_LABEL: Record<ExportFormat, string> = { txt: '纯文本 TXT', md: 'Markdown', epub: 'EPUB 电子书', docx: 'Word DOCX' };
const FORMAT_FILTER: Record<ExportFormat, string> = { txt: '文本', md: 'Markdown', epub: 'EPUB', docx: 'Word 文档' };
const TEXT_FORMATS: ExportFormat[] = ['txt', 'md'];

export function isTextFormat(format: ExportFormat): boolean {
  return TEXT_FORMATS.includes(format);
}

/** 按章号闭区间挑选章节；顺序始终按章号升序。 */
export function selectChapters(chapters: ExportChapter[], range?: ExportRange | null): ExportChapter[] {
  const from = range?.from ?? null;
  const to = range?.to ?? null;
  return chapters
    .filter((c) => (from === null || c.chapterNo >= from) && (to === null || c.chapterNo <= to))
    .sort((a, b) => a.chapterNo - b.chapterNo);
}

/** 一章的标题行，两端都可能为空。 */
export function chapterHeading(c: ExportChapter): string {
  return `第${c.chapterNo}章 ${c.title}`.trim();
}

/** 正文按空行切段，顺带去掉行尾空白。 */
function paragraphs(content: string): string[] {
  return content
    .replace(/\r\n?/g, '\n')
    .split(/\n{1,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

const enc = new TextEncoder();
const utf8 = (s: string): Uint8Array => enc.encode(s);

function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

function metaLines(meta: ExportMeta): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (meta.author) out.push(['作者', meta.author]);
  if (meta.description) out.push(['简介', meta.description]);
  if (meta.license) out.push(['许可', meta.license]);
  return out;
}

/** 稳定的标识符：优先用调用方给的，否则按书名折算一个 urn。 */
function identifierOf(meta: ExportMeta): string {
  if (meta.identifier) return meta.identifier;
  let h = 0;
  for (const ch of meta.title) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return `urn:the-water:${h.toString(16).padStart(8, '0')}`;
}

function isoDate(meta: ExportMeta): string {
  return `${(meta.date ?? new Date()).toISOString().slice(0, 19)}Z`;
}

// ── 纯文本 ────────────────────────────────────────────────────────────────

export function buildTxt(chapters: ExportChapter[], meta: ExportMeta): string {
  const head = [`《${meta.title}》`, ...metaLines(meta).map(([k, v]) => `${k}：${v}`)];
  const body = chapters.map((c) => `${chapterHeading(c)}\n\n${paragraphs(c.content).join('\n\n')}`);
  return `${[head.join('\n'), ...body].join('\n\n\n')}\n`;
}

// ── Markdown ─────────────────────────────────────────────────────────────

/** YAML 前置元数据里的值，统一用双引号包起来。 */
function yamlValue(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
}

export function buildMarkdown(chapters: ExportChapter[], meta: ExportMeta): string {
  const front = [
    '---',
    `title: ${yamlValue(meta.title)}`,
    `author: ${yamlValue(meta.author)}`,
    `description: ${yamlValue(meta.description)}`,
    `license: ${yamlValue(meta.license)}`,
    `language: ${yamlValue(meta.language ?? 'zh-CN')}`,
    `date: ${yamlValue(isoDate(meta))}`,
    '---',
  ].join('\n');
  const head = [`# ${meta.title}`, ...metaLines(meta).map(([k, v]) => `**${k}**：${v}`)].join('\n\n');
  const body = chapters.map((c) => `## ${chapterHeading(c)}\n\n${paragraphs(c.content).join('\n\n')}`);
  return `${[front, head, ...body].join('\n\n')}\n`;
}

// ── EPUB 3 ───────────────────────────────────────────────────────────────

const EPUB_CSS = `body { font-family: serif; line-height: 1.8; margin: 0 6%; }
h1 { font-size: 1.4em; margin: 2em 0 1em; text-align: center; }
p { margin: 0 0 0.9em; text-indent: 2em; }
.meta { color: #666; font-size: 0.9em; text-align: center; text-indent: 0; }`;

function xhtml(title: string, body: string, lang: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head><meta charset="utf-8"/><title>${xmlEscape(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
${body}
</body>
</html>`;
}

const chapterFile = (i: number): string => `chapter-${String(i + 1).padStart(4, '0')}.xhtml`;

/** 打成 EPUB 3：mimetype 必须是第一个条目且不压缩。 */
export function buildEpub(chapters: ExportChapter[], meta: ExportMeta): Uint8Array {
  const lang = meta.language ?? 'zh-CN';
  const id = identifierOf(meta);
  const modified = isoDate(meta);

  const titlePage = xhtml(
    meta.title,
    [`<h1>${xmlEscape(meta.title)}</h1>`, ...metaLines(meta).map(([k, v]) => `<p class="meta">${xmlEscape(k)}：${xmlEscape(v)}</p>`)].join('\n'),
    lang,
  );
  const chapterDocs = chapters.map((c) =>
    xhtml(chapterHeading(c), [`<h1>${xmlEscape(chapterHeading(c))}</h1>`, ...paragraphs(c.content).map((p) => `<p>${xmlEscape(p)}</p>`)].join('\n'), lang),
  );

  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="css" href="style.css" media-type="text/css"/>',
    '<item id="titlepage" href="titlepage.xhtml" media-type="application/xhtml+xml"/>',
    ...chapters.map((_, i) => `<item id="ch${i + 1}" href="${chapterFile(i)}" media-type="application/xhtml+xml"/>`),
  ].join('\n    ');
  const spine = ['<itemref idref="titlepage"/>', ...chapters.map((_, i) => `<itemref idref="ch${i + 1}"/>`)].join('\n    ');
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${lang}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${xmlEscape(id)}</dc:identifier>
    <dc:title>${xmlEscape(meta.title)}</dc:title>
    <dc:language>${lang}</dc:language>
    <dc:creator>${xmlEscape(meta.author)}</dc:creator>
    <dc:description>${xmlEscape(meta.description)}</dc:description>
    <dc:rights>${xmlEscape(meta.license)}</dc:rights>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    ${manifest}
  </manifest>
  <spine toc="ncx">
    ${spine}
  </spine>
</package>`;

  const navItems = chapters.map((c, i) => `<li><a href="${chapterFile(i)}">${xmlEscape(chapterHeading(c))}</a></li>`).join('\n      ');
  const nav = xhtml(
    '目录',
    `<nav epub:type="toc" id="toc">
  <h1>目录</h1>
  <ol>
      <li><a href="titlepage.xhtml">${xmlEscape(meta.title)}</a></li>
      ${navItems}
  </ol>
</nav>`,
    lang,
  );

  const navPoints = chapters
    .map(
      (c, i) => `<navPoint id="np${i + 2}" playOrder="${i + 2}"><navLabel><text>${xmlEscape(chapterHeading(c))}</text></navLabel><content src="${chapterFile(i)}"/></navPoint>`,
    )
    .join('\n    ');
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${lang}">
  <head><meta name="dtb:uid" content="${xmlEscape(id)}"/><meta name="dtb:depth" content="1"/></head>
  <docTitle><text>${xmlEscape(meta.title)}</text></docTitle>
  <navMap>
    <navPoint id="np1" playOrder="1"><navLabel><text>${xmlEscape(meta.title)}</text></navLabel><content src="titlepage.xhtml"/></navPoint>
    ${navPoints}
  </navMap>
</ncx>`;

  const files: Zippable = {
    // mimetype 必须不压缩、排在最前面，阅读器靠它嗅探格式
    mimetype: [utf8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': utf8(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
    'OEBPS/content.opf': utf8(opf),
    'OEBPS/nav.xhtml': utf8(nav),
    'OEBPS/toc.ncx': utf8(ncx),
    'OEBPS/style.css': utf8(EPUB_CSS),
    'OEBPS/titlepage.xhtml': utf8(titlePage),
  };
  chapterDocs.forEach((doc, i) => { files[`OEBPS/${chapterFile(i)}`] = utf8(doc); });
  return zipSync(files, { mtime: meta.date ?? new Date() });
}

// ── DOCX ─────────────────────────────────────────────────────────────────

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function docxParagraph(text: string, style?: string): string {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

const DOCX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:eastAsia="宋体" w:hAnsi="Georgia"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:line="360" w:lineRule="auto"/><w:ind w:firstLine="480"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="52"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:color w:val="666666"/><w:sz w:val="20"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/><w:ind w:firstLine="0"/><w:spacing w:before="480" w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
</w:styles>`;

/** 打成 DOCX：最小可用的 OOXML 包（document + styles + 文档属性）。 */
export function buildDocx(chapters: ExportChapter[], meta: ExportMeta): Uint8Array {
  const body = [
    docxParagraph(meta.title, 'Title'),
    ...metaLines(meta).map(([k, v]) => docxParagraph(`${k}：${v}`, 'Subtitle')),
    ...chapters.flatMap((c) => [docxParagraph(chapterHeading(c), 'Heading1'), ...paragraphs(c.content).map((p) => docxParagraph(p))]),
  ].join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;

  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEscape(meta.title)}</dc:title>
  <dc:creator>${xmlEscape(meta.author)}</dc:creator>
  <cp:lastModifiedBy>${xmlEscape(meta.author)}</cp:lastModifiedBy>
  <dc:description>${xmlEscape(meta.description)}</dc:description>
  <cp:keywords>${xmlEscape(meta.license)}</cp:keywords>
  <dc:language>${meta.language ?? 'zh-CN'}</dc:language>
  <dcterms:created xsi:type="dcterms:W3CDTF">${isoDate(meta)}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${isoDate(meta)}</dcterms:modified>
</cp:coreProperties>`;

  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>The Water</Application><Company>${xmlEscape(meta.license)}</Company>
</Properties>`;

  const files: Zippable = {
    '[Content_Types].xml': utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`),
    '_rels/.rels': utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`),
    'word/document.xml': utf8(document),
    'word/styles.xml': utf8(DOCX_STYLES),
    'word/_rels/document.xml.rels': utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    'docProps/core.xml': utf8(core),
    'docProps/app.xml': utf8(app),
  };
  return zipSync(files, { mtime: meta.date ?? new Date() });
}

// ── 统一入口 ──────────────────────────────────────────────────────────────

/** 按格式产出文件字节。纯函数：输入章节 + 元数据，输出 bytes。 */
export function buildExportBytes(format: ExportFormat, chapters: ExportChapter[], meta: ExportMeta): Uint8Array {
  switch (format) {
    case 'txt': return utf8(buildTxt(chapters, meta));
    case 'md': return utf8(buildMarkdown(chapters, meta));
    case 'epub': return buildEpub(chapters, meta);
    case 'docx': return buildDocx(chapters, meta);
  }
}

/** 文本格式仍然可以直接拿字符串（TXT / MD 写文件时用 writeTextFile）。 */
export function buildExportText(chapters: ExportChapter[], meta: ExportMeta, format: 'txt' | 'md'): string {
  return format === 'md' ? buildMarkdown(chapters, meta) : buildTxt(chapters, meta);
}

/** 文件名里不能出现的字符换成下划线。 */
export function safeFileName(name: string): string {
  return (name.trim() || '小说').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

export function exportFileName(meta: ExportMeta, format: ExportFormat, range?: ExportRange | null): string {
  const from = range?.from ?? null;
  const to = range?.to ?? null;
  const suffix = from === null && to === null ? '' : `（第${from ?? 1}-${to ?? '末'}章）`;
  return `${safeFileName(meta.title)}${suffix}.${format}`;
}

// ── 与数据库 / 系统对话框打交道的薄层 ──────────────────────────────────────

/** 取一本小说所有「有正文」的章节，按章号升序。 */
export async function collectExportChapters(novelId: string, draft = false): Promise<ExportChapter[]> {
  const rows = await listCurrentVersions(novelId, { draft });
  return rows
    .filter((r) => r.version && r.version.content.trim())
    .map((r) => ({ chapterNo: r.chapter.chapterNo, title: r.chapter.title, content: r.version!.content }))
    .sort((a, b) => a.chapterNo - b.chapterNo);
}

/** 从小说记录拼出默认元数据；作者与许可由调用方补。 */
export function metaFromNovel(novel: Novel, extra?: Partial<ExportMeta>): ExportMeta {
  return {
    title: novel.title || '未命名故事',
    author: '',
    description: novel.meta.logline || novel.premise || '',
    license: '',
    language: 'zh-CN',
    identifier: `urn:the-water:novel:${novel.id}`,
    ...extra,
  };
}

/** 弹保存对话框并写文件。返回路径，取消则返回 null。 */
export async function exportNovel(novel: Novel, format: ExportFormat, options?: { draft?: boolean; range?: ExportRange | null; meta?: Partial<ExportMeta> }): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const { writeFile, writeTextFile } = await import('@tauri-apps/plugin-fs');
  const meta = metaFromNovel(novel, options?.meta);
  const chapters = selectChapters(await collectExportChapters(novel.id, options?.draft), options?.range);
  if (chapters.length === 0) throw new Error('这个范围里还没有写好的章节');
  const path = await save({ defaultPath: exportFileName(meta, format, options?.range), filters: [{ name: FORMAT_FILTER[format], extensions: [format] }] });
  if (!path) return null;
  if (isTextFormat(format)) await writeTextFile(path, buildExportText(chapters, meta, format as 'txt' | 'md'));
  else await writeFile(path, buildExportBytes(format, chapters, meta));
  return path;
}
