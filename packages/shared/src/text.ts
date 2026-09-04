/** 起点式字数：去掉所有空白后按 Unicode 码点计数（含标点）。 */
export function countZh(text: string): number {
  return Array.from(text.replace(/\s+/g, '')).length;
}

/** 仅汉字计数（CJK 统一表意文字及扩展）。 */
export function countHanOnly(text: string): number {
  const m = text.match(/\p{Script=Han}/gu);
  return m ? m.length : 0;
}

/**
 * 章节正文归一化：NFC、CRLF/CR → LF、去掉末尾空白。
 * 内部空行属于作者内容，不动。两端必须使用同一实现以保证 hash 一致。
 */
export function normalizeChapterText(s: string): string {
  return s.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\s+$/u, '');
}

/** 把整本正文按「第X章」标题切分（用于导入 txt/md）。 */
export function splitChapters(text: string): Array<{ title: string; content: string }> {
  const norm = normalizeChapterText(text);
  const re = /^\s*(第\s*[0-9零一二三四五六七八九十百千两〇]+\s*[章节回卷][^\n]*)$/gmu;
  const marks: Array<{ idx: number; title: string; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm)) !== null) {
    marks.push({ idx: m.index, title: m[1]!.trim(), end: m.index + m[0].length });
  }
  if (marks.length === 0) return [{ title: '第一章', content: norm.trim() }];
  const out: Array<{ title: string; content: string }> = [];
  for (let i = 0; i < marks.length; i++) {
    const cur = marks[i]!;
    const next = marks[i + 1];
    const body = norm.slice(cur.end, next ? next.idx : undefined).trim();
    out.push({ title: cur.title, content: body });
  }
  return out;
}
