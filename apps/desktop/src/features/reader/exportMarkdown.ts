import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { fmt, t } from '@/i18n';
import type { Highlight } from '@/db/repos/highlightsRepo';
import { colorLabel } from './colors';

export interface ExportDocMeta {
  title: string;
  author?: string | null;
  pageCount?: number;
}

/** 划线与笔记导出成 Markdown：按页分组，先原文引用，再自己的笔记。 */
export function buildHighlightsMarkdown(doc: ExportDocMeta, highlights: Highlight[], exportedAt = new Date()): string {
  const lines: string[] = [];
  lines.push(`# ${doc.title || t.common.untitledDoc}`);
  lines.push('');
  const meta: string[] = [];
  if (doc.author) meta.push(doc.author);
  meta.push(fmt(t.reader.export.countLine, { n: highlights.length }));
  meta.push(fmt(t.reader.export.exportedAt, { date: formatDate(exportedAt) }));
  lines.push(`> ${meta.join(' · ')}`);
  lines.push('');
  if (highlights.length === 0) {
    lines.push(t.reader.export.empty);
    lines.push('');
    return lines.join('\n');
  }
  const byPage = new Map<number, Highlight[]>();
  for (const h of highlights) byPage.set(h.pageNo, [...(byPage.get(h.pageNo) ?? []), h]);
  for (const [page, list] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`## ${fmt(t.reader.page, { n: page })}`);
    lines.push('');
    for (const h of [...list].sort((a, b) => a.createdAt - b.createdAt)) {
      const quote = (h.anchor.exact || '').trim();
      if (quote) {
        for (const l of quote.split('\n')) lines.push(`> ${l}`);
        lines.push('');
      }
      const label = colorLabel(h.color);
      const tag = label ? `（${label}）` : '';
      if (h.noteText.trim()) {
        lines.push(fmt(t.reader.export.noteLine, { tag, text: h.noteText.trim().replace(/\n/g, '  \n') }));
        lines.push('');
      } else if (tag) {
        lines.push(fmt(t.reader.export.highlightLine, { tag }));
        lines.push('');
      }
      lines.push(fmt(t.reader.export.pageFooter, { n: page }));
      lines.push('');
    }
  }
  return lines.join('\n');
}

function formatDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 选一个位置写出去；用户取消返回 null。 */
export async function exportHighlights(doc: ExportDocMeta, highlights: Highlight[]): Promise<string | null> {
  const path = await save({
    defaultPath: `${sanitize(doc.title) || t.reader.export.fileName}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (!path) return null;
  await writeTextFile(path, buildHighlightsMarkdown(doc, highlights));
  return path;
}

/** 文件名里去掉路径分隔符等不安全字符。 */
export function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}
