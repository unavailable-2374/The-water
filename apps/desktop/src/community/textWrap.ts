/**
 * Canvas 分享图的中文折行：按字符量宽度，超出行数时最后一行加省略号。
 * measure 由调用方注入（画布用 ctx.measureText），因此这个函数可以单测。
 */
export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number, maxLines: number): string[] {
  const source = text.replace(/\s+/g, ' ').trim();
  if (!source || maxLines <= 0 || maxWidth <= 0) return [];
  const chars = Array.from(source);
  const lines: string[] = [];
  let line = '';
  for (const ch of chars) {
    const next = line + ch;
    if (line && measure(next) > maxWidth) {
      lines.push(line);
      line = ch;
      if (lines.length === maxLines) break;
    } else {
      line = next;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);

  const consumed = lines.join('').length;
  if (consumed < chars.length && lines.length) {
    const last = lines[lines.length - 1]!;
    let trimmed = last;
    while (trimmed && measure(`${trimmed}…`) > maxWidth) trimmed = trimmed.slice(0, -1);
    lines[lines.length - 1] = `${trimmed}…`;
  }
  return lines;
}
