/** 阅读器快捷键表：匹配逻辑与帮助浮层共用同一份键表。 */
import { t } from '@/i18n';

export type ReaderAction =
  | 'prevPage'
  | 'nextPage'
  | 'firstPage'
  | 'lastPage'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'find'
  | 'findNext'
  | 'findPrev'
  | 'toggleOutline'
  | 'toggleSidebar'
  | 'help'
  | 'escape';

/** 帮助浮层里的分组；界面上显示的标题从词典里取。 */
export type ShortcutGroup = 'paging' | 'zoom' | 'find' | 'ui';

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ShortcutSpec {
  action: ReaderAction;
  /** 帮助浮层里显示的按键 */
  keys: string[];
  label: string;
  group: ShortcutGroup;
  match: (e: KeyEventLike) => boolean;
}

/** Cmd（macOS）或 Ctrl（其他平台） */
const mod = (e: KeyEventLike) => e.metaKey || e.ctrlKey;
const plain = (e: KeyEventLike) => !e.metaKey && !e.ctrlKey && !e.altKey;

/**
 * 表里的 `label` / `keys` 都写成 getter：这张表是模块顶层常量，
 * 若直接把 `t.reader.shortcuts.*` 拷进来，切换语言后浮层还会停在旧文案。
 * getter 每次读取都回当前词典里取，行为与 `t` 的惰性代理一致。
 */
export const SHORTCUTS: ShortcutSpec[] = [
  { action: 'prevPage', group: 'paging',
    get keys() { return ['←', 'PageUp', t.reader.shortcuts.shiftSpace]; },
    get label() { return t.reader.shortcuts.prevPage; },
    match: (e) => plain(e) && (e.key === 'ArrowLeft' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) },
  { action: 'nextPage', group: 'paging',
    get keys() { return ['→', 'PageDown', t.reader.shortcuts.space]; },
    get label() { return t.reader.shortcuts.nextPage; },
    match: (e) => plain(e) && (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) },
  { action: 'firstPage', group: 'paging', keys: ['Home'],
    get label() { return t.reader.shortcuts.firstPage; },
    match: (e) => plain(e) && e.key === 'Home' },
  { action: 'lastPage', group: 'paging', keys: ['End'],
    get label() { return t.reader.shortcuts.lastPage; },
    match: (e) => plain(e) && e.key === 'End' },
  { action: 'zoomIn', group: 'zoom', keys: ['⌘/Ctrl +'],
    get label() { return t.reader.shortcuts.zoomIn; },
    match: (e) => mod(e) && (e.key === '+' || e.key === '=') },
  { action: 'zoomOut', group: 'zoom', keys: ['⌘/Ctrl -'],
    get label() { return t.reader.shortcuts.zoomOut; },
    match: (e) => mod(e) && (e.key === '-' || e.key === '_') },
  { action: 'zoomReset', group: 'zoom', keys: ['⌘/Ctrl 0'],
    get label() { return t.reader.shortcuts.zoomReset; },
    match: (e) => mod(e) && e.key === '0' },
  { action: 'find', group: 'find', keys: ['⌘/Ctrl F'],
    get label() { return t.reader.shortcuts.find; },
    match: (e) => mod(e) && !e.shiftKey && (e.key === 'f' || e.key === 'F') },
  { action: 'findNext', group: 'find', keys: ['⌘/Ctrl G', 'Enter'],
    get label() { return t.reader.shortcuts.findNext; },
    match: (e) => mod(e) && !e.shiftKey && (e.key === 'g' || e.key === 'G') },
  { action: 'findPrev', group: 'find', keys: ['⌘/Ctrl ⇧ G'],
    get label() { return t.reader.shortcuts.findPrev; },
    match: (e) => mod(e) && e.shiftKey && (e.key === 'g' || e.key === 'G') },
  { action: 'toggleOutline', group: 'ui', keys: ['⌘/Ctrl B'],
    get label() { return t.reader.shortcuts.toggleOutline; },
    match: (e) => mod(e) && (e.key === 'b' || e.key === 'B') },
  { action: 'toggleSidebar', group: 'ui', keys: ['⌘/Ctrl \\'],
    get label() { return t.reader.shortcuts.toggleSidebar; },
    match: (e) => mod(e) && e.key === '\\' },
  { action: 'help', group: 'ui', keys: ['?'],
    get label() { return t.reader.shortcuts.help; },
    match: (e) => plain(e) && e.key === '?' },
  { action: 'escape', group: 'ui', keys: ['Esc'],
    get label() { return t.reader.shortcuts.escape; },
    match: (e) => e.key === 'Escape' },
];

/** 命中哪一个动作；没有命中返回 null。 */
export function matchShortcut(e: KeyEventLike): ReaderAction | null {
  for (const s of SHORTCUTS) if (s.match(e)) return s.action;
  return null;
}

/** 焦点在输入框里时，除了 Esc 与带修饰键的组合，其余快捷键让位给输入。 */
export function shouldIgnoreTarget(tagName: string | undefined, isContentEditable: boolean, e: KeyEventLike): boolean {
  const typing = isContentEditable || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
  if (!typing) return false;
  if (e.key === 'Escape') return false;
  return !(e.metaKey || e.ctrlKey);
}

/** 帮助浮层按分组展示；`title` 是分组在界面上的名字。 */
export function shortcutGroups(): Array<{ group: ShortcutGroup; title: string; items: ShortcutSpec[] }> {
  const order: ShortcutGroup[] = ['paging', 'zoom', 'find', 'ui'];
  return order.map((group) => ({
    group,
    title: t.reader.shortcuts.groups[group],
    items: SHORTCUTS.filter((s) => s.group === group),
  }));
}
