/** 阅读器：工具栏、笔记、搜索、目录、快捷键、导出。 */
export const reader = {
  title: '阅读器', highlight: '高亮', addNote: '记笔记', notes: '笔记', ai: 'AI 讨论',
  searchInDoc: '在文档中搜索', page: '第 {n} 页', selectedPassage: '所选段落',
  noNotes: '在书页上选一段文字，把它划下来，或写下此刻的想法。', jumpTo: '跳转', indexing: '正在提取文本…',

  /* 顶栏 */
  library: '书架',
  backToLibrary: '回到书架',
  outlineToggle: '目录 / 缩略图 (⌘B)',
  zoomIn: '放大 (⌘+)', zoomOut: '缩小 (⌘-)', zoomReset: '恢复 100% (⌘0)',
  themeGroup: '阅读主题', themeMode: '{label}读模式',
  panelGroup: '侧栏面板',
  myNotes: '我的笔记', find: '查找',
  shortcutsTip: '快捷键 (?)',
  expandSidebar: '展开侧栏 (⌘\\)', collapseSidebar: '收起侧栏 (⌘\\)',
  prevPage: '上一页 (←)', nextPage: '下一页 (→)',
  pageInput: '页码', pageInputTip: '输入页码后回车跳转', pageTotal: '共 {n} 页',
  resizeSidebar: '拖动或用左右方向键调整侧栏宽度（{min}–{max}）',

  /* 文档区 */
  docNotFound: '文档不存在',
  openFailed: '打不开这个文档：{message}',
  opening: '正在翻开这本书…',
  content: '书页内容',
  scanNotice: '这本书没有文字层（多半是扫描件），只能看图：搜索、划线和 AI 讨论都用不了。文字识别（OCR）还在计划里。',
  gotIt: '知道了',
  indexCancelled: '文本提取已取消',
  indexFailed: '文本提取失败',

  /* 选段气泡 */
  selectionActions: '选中文字的操作',
  discussPassage: '和 AI 聊聊这段',
  notePlaceholder: '写下此刻的想法…',
  colorGroup: '颜色',
  noteSaved: '笔记已保存', highlighted: '已高亮',

  /* 笔记面板 */
  noteCount: '{n} 条',
  missingTip: '这些划线在当前页面文本里找不到了',
  missingCount: '{n} 条无法定位',
  missingDetail: '无法定位：页面文本已经变了，原文还在这里，但书上不再标出。',
  exportTip: '导出为 Markdown', exportAction: '导出', exportedTo: '已导出到 {path}',
  emptyNotes: '还没有笔记',
  jumpToNote: '跳到第 {n} 页的这条划线',

  /* 左侧目录 / 缩略图 */
  outline: '目录', thumbnails: '缩略图',
  outlineLoading: '正在读目录…',
  outlineEmpty: '这本书没有目录。可以用缩略图或页码跳转。',
  outlineFailed: '目录读不出来',
  expandNode: '展开「{title}」', collapseNode: '收起「{title}」',
  thumbnailOf: '第 {n} 页缩略图',

  /* 搜索面板 */
  searchPlaceholder: '在这本书里找…',
  clear: '清空',
  searching: '正在找…',
  hitPosition: '第 {i} / {n} 条 · {pages} 页',
  hitTruncated: ' · 只显示前 {n} 条',
  noHits: '没有找到',
  indexingPartial: '正在提取文本 {done}/{total}，建好之前搜不全',
  prevHit: '上一条 (⌘⇧G)', nextHit: '下一条 (⌘G)',
  noHitsDetail: '这本书里没有找到相关的文字',
  stillIndexing: '（文本还在提取中，稍后再试试）',
  searchFailed: '没能搜索：{message}',
  searchResults: '搜索结果',

  /* 阅读主题名 */
  themes: { paper: '纸', night: '夜', eye: '护眼' },

  /* 高亮色名 */
  colors: { yellow: '黄', green: '绿', blue: '蓝', pink: '粉' },

  /* 快捷键帮助 */
  shortcuts: {
    title: '快捷键',
    subtitle: '按 ? 随时唤起这张表',
    wheelZoom: '另外：按住 Ctrl / ⌘ 滚动鼠标滚轮可以缩放页面。',
    groups: { paging: '翻页', zoom: '缩放', find: '查找', ui: '界面' },
    space: '空格', shiftSpace: 'Shift+空格',
    prevPage: '上一页', nextPage: '下一页', firstPage: '第一页', lastPage: '最后一页',
    zoomIn: '放大', zoomOut: '缩小', zoomReset: '恢复 100%',
    find: '在这本书里找', findNext: '下一条命中', findPrev: '上一条命中',
    toggleOutline: '目录 / 缩略图', toggleSidebar: '收起 / 展开侧栏',
    help: '快捷键帮助', escape: '关闭浮层 / 取消选择',
  },

  /* 划线导出 */
  export: {
    countLine: '{n} 条划线与笔记',
    exportedAt: '导出于 {date}',
    empty: '（这本书还没有划线或笔记。）',
    noteLine: '**笔记{tag}**：{text}',
    highlightLine: '**划线{tag}**',
    pageFooter: '— 第 {n} 页',
    fileName: '划线与笔记',
  },
} as const;
