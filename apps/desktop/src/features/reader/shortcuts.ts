/** 阅读器快捷键表：匹配逻辑与帮助浮层共用同一份数据。 */

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
  group: '翻页' | '缩放' | '查找' | '界面';
  match: (e: KeyEventLike) => boolean;
}

/** Cmd（macOS）或 Ctrl（其他平台） */
const mod = (e: KeyEventLike) => e.metaKey || e.ctrlKey;
const plain = (e: KeyEventLike) => !e.metaKey && !e.ctrlKey && !e.altKey;

export const SHORTCUTS: ShortcutSpec[] = [
  { action: 'prevPage', keys: ['←', 'PageUp', 'Shift+空格'], label: '上一页', group: '翻页',
    match: (e) => plain(e) && (e.key === 'ArrowLeft' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) },
  { action: 'nextPage', keys: ['→', 'PageDown', '空格'], label: '下一页', group: '翻页',
    match: (e) => plain(e) && (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) },
  { action: 'firstPage', keys: ['Home'], label: '第一页', group: '翻页', match: (e) => plain(e) && e.key === 'Home' },
  { action: 'lastPage', keys: ['End'], label: '最后一页', group: '翻页', match: (e) => plain(e) && e.key === 'End' },
  { action: 'zoomIn', keys: ['⌘/Ctrl +'], label: '放大', group: '缩放',
    match: (e) => mod(e) && (e.key === '+' || e.key === '=') },
  { action: 'zoomOut', keys: ['⌘/Ctrl -'], label: '缩小', group: '缩放',
    match: (e) => mod(e) && (e.key === '-' || e.key === '_') },
  { action: 'zoomReset', keys: ['⌘/Ctrl 0'], label: '恢复 100%', group: '缩放', match: (e) => mod(e) && e.key === '0' },
  { action: 'find', keys: ['⌘/Ctrl F'], label: '在这本书里找', group: '查找',
    match: (e) => mod(e) && !e.shiftKey && (e.key === 'f' || e.key === 'F') },
  { action: 'findNext', keys: ['⌘/Ctrl G', 'Enter'], label: '下一条命中', group: '查找',
    match: (e) => mod(e) && !e.shiftKey && (e.key === 'g' || e.key === 'G') },
  { action: 'findPrev', keys: ['⌘/Ctrl ⇧ G'], label: '上一条命中', group: '查找',
    match: (e) => mod(e) && e.shiftKey && (e.key === 'g' || e.key === 'G') },
  { action: 'toggleOutline', keys: ['⌘/Ctrl B'], label: '目录 / 缩略图', group: '界面',
    match: (e) => mod(e) && (e.key === 'b' || e.key === 'B') },
  { action: 'toggleSidebar', keys: ['⌘/Ctrl \\'], label: '收起 / 展开侧栏', group: '界面',
    match: (e) => mod(e) && e.key === '\\' },
  { action: 'help', keys: ['?'], label: '快捷键帮助', group: '界面', match: (e) => plain(e) && e.key === '?' },
  { action: 'escape', keys: ['Esc'], label: '关闭浮层 / 取消选择', group: '界面', match: (e) => e.key === 'Escape' },
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

/** 帮助浮层按分组展示。 */
export function shortcutGroups(): Array<{ group: ShortcutSpec['group']; items: ShortcutSpec[] }> {
  const order: ShortcutSpec['group'][] = ['翻页', '缩放', '查找', '界面'];
  return order.map((group) => ({ group, items: SHORTCUTS.filter((s) => s.group === group) }));
}
