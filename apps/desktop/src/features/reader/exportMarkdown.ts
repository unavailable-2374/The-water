import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import type { Highlight } from '@/db/repos/highlightsRepo';

export interface ExportDocMeta {
  title: string;
  author?: string | null;
  pageCount?: number;
}

const COLOR_LABEL: Record<string, string> = { yellow: '黄', green: '绿', blue: '蓝', pink: '粉' };

/** 划线与笔记导出成 Markdown：按页分组，先原文引用，再自己的笔记。 */
export function buildHighlightsMarkdown(doc: ExportDocMeta, highlights: Highlight[], exportedAt = new Date()): string {
  const lines: string[] = [];
  lines.push(`# ${doc.title || '未命名文档'}`);
  lines.push('');
  const meta: string[] = [];
  if (doc.author) meta.push(doc.author);
  meta.push(`${highlights.length} 条划线与笔记`);
  meta.push(`导出于 ${formatDate(exportedAt)}`);
  lines.push(`> ${meta.join(' · ')}`);
  lines.push('');
  if (highlights.length === 0) {
    lines.push('（这本书还没有划线或笔记。）');
    lines.push('');
    return lines.join('\n');
  }
  const byPage = new Map<number, Highlight[]>();
  for (const h of highlights) byPage.set(h.pageNo, [...(byPage.get(h.pageNo) ?? []), h]);
  for (const [page, list] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`## 第 ${page} 页`);
    lines.push('');
    for (const h of [...list].sort((a, b) => a.createdAt - b.createdAt)) {
      const quote = (h.anchor.exact || '').trim();
      if (quote) {
        for (const l of quote.split('\n')) lines.push(`> ${l}`);
        lines.push('');
      }
      const tag = COLOR_LABEL[h.color] ? `（${COLOR_LABEL[h.color]}）` : '';
      if (h.noteText.trim()) {
        lines.push(`**笔记${tag}**：${h.noteText.trim().replace(/\n/g, '  \n')}`);
        lines.push('');
      } else if (tag) {
        lines.push(`**划线${tag}**`);
        lines.push('');
      }
      lines.push(`— 第 ${page} 页`);
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
    defaultPath: `${sanitize(doc.title) || '划线与笔记'}.md`,
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
