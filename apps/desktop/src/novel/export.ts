import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { listCurrentVersions } from '@/db/repos/chaptersRepo';
import type { Novel } from '@/db/repos/novelsRepo';

export type ExportFormat = 'txt' | 'md';

export async function buildExportText(novel: Novel, format: ExportFormat): Promise<string> {
  const rows = await listCurrentVersions(novel.id);
  const parts: string[] = [];
  if (format === 'md') {
    parts.push(`# ${novel.title}\n`);
    if (novel.meta.logline) parts.push(`> ${novel.meta.logline}\n`);
  } else parts.push(`${novel.title}\n`);
  for (const { chapter, version } of rows) {
    if (!version) continue;
    const heading = `第${chapter.chapterNo}章 ${chapter.title}`.trim();
    parts.push(format === 'md' ? `\n## ${heading}\n\n${version.content}\n` : `\n${heading}\n\n${version.content}\n`);
  }
  return parts.join('\n');
}

/** Ask for a destination and write the whole book. Returns the path or null if cancelled. */
export async function exportNovel(novel: Novel, format: ExportFormat): Promise<string | null> {
  const path = await save({ defaultPath: `${novel.title || '小说'}.${format}`, filters: [{ name: format === 'md' ? 'Markdown' : '文本', extensions: [format] }] });
  if (!path) return null;
  await writeTextFile(path, await buildExportText(novel, format));
  return path;
}
