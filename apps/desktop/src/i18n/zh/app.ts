/** 全局通用文案：应用名、侧栏导航、按钮、错误、任务状态。 */
export const app = {
  name: 'The Water',
  /** 侧栏左上角那个方块里的字，中文版是「水」。换语言时应换成对应的单字/字母。 */
  mark: '水',
  tagline: '读一本书，写一个故事',
  starting: '正在启动…',
} as const;

export const nav = {
  groupRead: '阅读', groupWrite: '写作', groupDiscover: '发现',
  library: '书架', studio: '我的故事', public: '公共书房', settings: '设置', chat: '随手问 AI', notifications: '通知',
  /** 侧栏本身的无障碍名字。 */
  sidebar: '主导航',
} as const;

export const common = {
  save: '保存', cancel: '取消', delete: '删除', confirm: '确认', close: '关闭', edit: '编辑', add: '添加', back: '返回',
  loading: '加载中…', empty: '暂无内容', retry: '重试', copy: '复制', copied: '已复制', search: '搜索', yes: '是', no: '否',
  chars: '字', pages: '页', unknownError: '发生未知错误', confirmDelete: '确定要删除吗？此操作不可撤销。',
  loadMore: '加载更多', more: '再看一些', reachedEnd: '— 已经翻到底了 —', trash: '回收站',
  untitledNovel: '未命名故事', untitledDoc: '未命名文档', untitled: '未命名',
  /** 启动时从环境变量里认出的供应商，会以这个名字落库。 */
  providerFromEnv: '{name}（环境变量）',
} as const;

export const error = {
  title: '出错了', titleSuffix: '出错了',
  desc: '这一块没能正常显示。可以先重试一次；还是不行的话，把错误详情复制出来发给我们。',
  detail: '错误详情', feedback: '复制错误详情',
  copied: '错误详情已复制，粘贴发给我们就好', copyFail: '复制失败，可以手动选中上面的文字',
  backHome: '回到书架', routeScope: '页面', startFailed: '启动失败',
  appScope: '应用', startScope: '启动',
  runtimeError: '运行错误：{message}', unhandledError: '未处理的错误：{message}',
  notFoundTitle: '这里没有东西', notFoundDesc: '「{path}」不是一个存在的页面，可能是链接过期了。',
} as const;

/**
 * 任务状态与任务类型的唯一文案出处。
 *
 * 以前有三套说同一件事的标签表：`t.jobs.status`、`JobsTab` 的 `JOB_STATUS_LABEL`、
 * `LibraryPage` 的小说 `statusLabel`。现在统一到这里，措辞取面向读者的那一套。
 */
export const jobs = {
  status: {
    queued: '排队中', running: 'AI 正在写作', pausing: '正在暂停', paused: '已暂停',
    cancelling: '正在停下', cancelled: '已取消', failed: '遇到问题', completed: '已完成',
  },
  type: {
    generate_novel: '写整本书', regenerate_chapter: '重写一章', rewrite: '改写章节',
    extract_style: '拆书提取文风', style_check: '审校一章', planning: '规划大纲与章节表',
  },
} as const;

/** 小说自身的状态（与任务状态是两回事，别再各写一份）。 */
export const novelStatus = {
  draft: '构思中', planning: '规划中', generating: 'AI 正在写', writing: '写作中', complete: '已完稿',
} as const;

/** 无障碍专用文案：只给读屏软件听，不显示在界面上。 */
export const a11y = {
  closeDialog: '关闭对话框', notifications: '通知', deleteItem: '删除「{name}」',
} as const;
