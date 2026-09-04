import type { Arc, Beat, Character, Setting, SettingKind } from '@the-water/shared';
import { t } from '@/i18n';
import type { Chapter } from '@/db/repos/chaptersRepo';
import type { SnapshotReason } from '@/db/repos/storylineRepo';

/** Everything the storyline editor shows, loaded from the normalized tables. */
export interface StorylineData {
  characters: Character[];
  settings: Setting[];
  arcs: Arc[];
  beats: Beat[];
  chapters: Chapter[];
}

export type EntityKind = 'character' | 'setting' | 'arc' | 'beat';

export type Selection =
  | { kind: 'premise' }
  | { kind: 'style' }
  | { kind: 'derivative' }
  | { kind: EntityKind; id: string }
  | { kind: 'chapter'; chapterNo: number };

// 文案一律现取现用：写成模块顶层的常量表会把当前语言拷贝下来，切语言就不更新了。
export function settingKindLabel(kind: SettingKind): string {
  return t.studio.storylineTab.settingKind[kind];
}

export function snapshotReasonLabel(reason: SnapshotReason): string {
  return t.studio.storylineTab.snapshotReason[reason];
}

/** Split a comma/semicolon separated field into trimmed, de-duplicated tokens. */
export function splitList(text: string): string[] {
  return Array.from(new Set(text.split(/[,，、;；\n]/).map((s) => s.trim()).filter(Boolean)));
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parse `key=value` lines into an object (for address books). */
export function parseKeyValueLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([^=＝:：]+)\s*[=＝:：]\s*(.+?)\s*$/.exec(line);
    if (m) out[m[1]!.trim()] = m[2]!.trim();
  }
  return out;
}
export function keyValueLines(obj: Record<string, string>): string {
  return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n');
}
export function splitLines(text: string): string[] {
  return text.split('\n').map((s) => s.trim()).filter(Boolean);
}
