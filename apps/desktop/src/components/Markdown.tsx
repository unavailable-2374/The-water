import { Fragment, type ReactNode } from 'react';

/** Tiny markdown renderer: paragraphs, headings, bullet lists, code blocks, inline code/bold/italic. */
export function Markdown({ text }: { text: string }) {
  const blocks = splitBlocks(text);
  return <div className="space-y-2 text-sm leading-relaxed">{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>;
}

function splitBlocks(text: string): ReactNode[] {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) buf.push(lines[i++]!);
      i++;
      out.push(<pre className="overflow-x-auto rounded-xl bg-paper-100 p-3 text-xs leading-relaxed text-ink-800 dark:bg-paper-950 dark:text-paper-100"><code>{buf.join('\n')}</code></pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { out.push(<p className="font-serif font-semibold tracking-wide">{inline(h[2]!)}</p>); i++; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*[-*]\s+/, ''));
      out.push(<ul className="list-disc space-y-0.5 pl-5">{items.map((it, k) => <li key={k}>{inline(it)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*\d+[.)]\s+/, ''));
      out.push(<ol className="list-decimal space-y-0.5 pl-5">{items.map((it, k) => <li key={k}>{inline(it)}</li>)}</ol>);
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !/^(#{1,4}\s|```|\s*[-*]\s+|\s*\d+[.)]\s+)/.test(lines[i]!)) buf.push(lines[i++]!);
    out.push(<p className="whitespace-pre-wrap">{inline(buf.join('\n'))}</p>);
  }
  return out;
}

function inline(s: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|「[^」]+」)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) parts.push(<code key={k++} className="rounded-md bg-paper-200/70 px-1 py-0.5 text-[0.85em] text-ink-800 dark:bg-paper-950/60 dark:text-paper-100">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('**')) parts.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('*')) parts.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    else parts.push(<span key={k++} className="text-tea-700 dark:text-tea-200">{tok}</span>);
    last = m.index + tok.length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}
