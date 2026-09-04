/** 阅读器：工具栏、笔记、搜索、目录、快捷键、导出。 */
import type { Locale } from '../shape';

export const reader: Locale['reader'] = {
  title: 'Reader', highlight: 'Highlight', addNote: 'Add note', notes: 'Notes', ai: 'AI chat',
  searchInDoc: 'Search in this document', page: 'Page {n}', selectedPassage: 'Selected passage',
  noNotes: 'Pick a passage on the page, highlight it, or write down what you are thinking right now.', jumpTo: 'Jump there', indexing: 'Extracting text…',

  /* 顶栏 */
  library: 'Bookshelf',
  backToLibrary: 'Back to the shelf',
  outlineToggle: 'Outline / thumbnails (⌘B)',
  zoomIn: 'Zoom in (⌘+)', zoomOut: 'Zoom out (⌘-)', zoomReset: 'Reset to 100% (⌘0)',
  themeGroup: 'Reading theme', themeMode: '{label} reading mode',
  panelGroup: 'Side panels',
  myNotes: 'My notes', find: 'Find',
  shortcutsTip: 'Keyboard shortcuts (?)',
  expandSidebar: 'Expand sidebar (⌘\\)', collapseSidebar: 'Collapse sidebar (⌘\\)',
  prevPage: 'Previous page (←)', nextPage: 'Next page (→)',
  pageInput: 'Page number', pageInputTip: 'Type a page number and press Enter to jump', pageTotal: '{n} pages in all',
  resizeSidebar: 'Drag, or use the left and right arrow keys, to resize the sidebar ({min}–{max})',

  /* 文档区 */
  docNotFound: 'Document not found',
  openFailed: 'Could not open this document: {message}',
  opening: 'Opening the book…',
  content: 'Page content',
  scanNotice: 'This book has no text layer (most likely a scan), so you can only look at the images: search, highlights and AI chat will not work. Text recognition (OCR) is still on the roadmap.',
  gotIt: 'Got it',
  indexCancelled: 'Text extraction cancelled',
  indexFailed: 'Text extraction failed',

  /* 选段气泡 */
  selectionActions: 'Actions for the selected text',
  discussPassage: 'Talk this passage over with AI',
  notePlaceholder: 'Write down what you are thinking…',
  colorGroup: 'Colour',
  noteSaved: 'Note saved', highlighted: 'Highlighted',

  /* 笔记面板 */
  noteCount: '{n} items',
  missingTip: 'These highlights can no longer be found in the current page text',
  missingCount: '{n} cannot be located',
  missingDetail: 'Cannot locate: the page text has changed. The passage is still here, but it is no longer marked in the book.',
  exportTip: 'Export as Markdown', exportAction: 'Export', exportedTo: 'Exported to {path}',
  emptyNotes: 'No notes yet',
  jumpToNote: 'Jump to this highlight on page {n}',

  /* 左侧目录 / 缩略图 */
  outline: 'Outline', thumbnails: 'Thumbnails',
  outlineLoading: 'Reading the outline…',
  outlineEmpty: 'This book has no outline. Use the thumbnails or a page number to jump around.',
  outlineFailed: 'Could not read the outline',
  expandNode: 'Expand “{title}”', collapseNode: 'Collapse “{title}”',
  thumbnailOf: 'Thumbnail of page {n}',

  /* 搜索面板 */
  searchPlaceholder: 'Find something in this book…',
  clear: 'Clear',
  searching: 'Searching…',
  hitPosition: 'Match {i} of {n} · {pages} pages',
  hitTruncated: ' · showing the first {n} only',
  noHits: 'Nothing found',
  indexingPartial: 'Extracting text {done}/{total} — search stays partial until it is done',
  prevHit: 'Previous match (⌘⇧G)', nextHit: 'Next match (⌘G)',
  noHitsDetail: 'No matching text in this book',
  stillIndexing: '(Text is still being extracted, try again in a moment)',
  searchFailed: 'Could not search: {message}',
  searchResults: 'Search results',

  /* 阅读主题名 */
  themes: { paper: 'Paper', night: 'Night', eye: 'Soft' },

  /* 高亮色名 */
  colors: { yellow: 'Yellow', green: 'Green', blue: 'Blue', pink: 'Pink' },

  /* 快捷键帮助 */
  shortcuts: {
    title: 'Keyboard shortcuts',
    subtitle: 'Press ? any time to bring this list back',
    wheelZoom: 'Also: hold Ctrl / ⌘ and scroll the mouse wheel to zoom the page.',
    groups: { paging: 'Paging', zoom: 'Zoom', find: 'Find', ui: 'Interface' },
    space: 'Space', shiftSpace: 'Shift+Space',
    prevPage: 'Previous page', nextPage: 'Next page', firstPage: 'First page', lastPage: 'Last page',
    zoomIn: 'Zoom in', zoomOut: 'Zoom out', zoomReset: 'Reset to 100%',
    find: 'Find in this book', findNext: 'Next match', findPrev: 'Previous match',
    toggleOutline: 'Outline / thumbnails', toggleSidebar: 'Collapse / expand sidebar',
    help: 'Shortcut help', escape: 'Close overlay / clear selection',
  },

  /* 划线导出 */
  export: {
    countLine: '{n} highlights and notes',
    exportedAt: 'Exported on {date}',
    empty: '(No highlights or notes in this book yet.)',
    noteLine: '**Note{tag}**: {text}',
    highlightLine: '**Highlight{tag}**',
    pageFooter: '— page {n}',
    fileName: 'Highlights and notes',
  },
};
