/** 全局通用文案：应用名、侧栏导航、按钮、错误、任务状态。 */
import type { Locale } from '../shape';

export const app: Locale['app'] = {
  name: 'The Water',
  /** 侧栏左上角那个方块里的字，中文版是「水」，英文用首字母。 */
  mark: 'W',
  tagline: 'Read a book, write a story',
  starting: 'Starting…',
};

export const nav: Locale['nav'] = {
  groupRead: 'Read', groupWrite: 'Write', groupDiscover: 'Discover',
  library: 'Bookshelf', studio: 'My stories', public: 'Public library', settings: 'Settings', chat: 'Ask AI', notifications: 'Notifications',
  /** 侧栏本身的无障碍名字。 */
  sidebar: 'Main navigation',
};

export const common: Locale['common'] = {
  save: 'Save', cancel: 'Cancel', delete: 'Delete', confirm: 'Confirm', close: 'Close', edit: 'Edit', add: 'Add', back: 'Back',
  loading: 'Loading…', empty: 'Nothing here yet', retry: 'Retry', copy: 'Copy', copied: 'Copied', search: 'Search', yes: 'Yes', no: 'No',
  chars: 'words', pages: 'pages', unknownError: 'Something went wrong', confirmDelete: 'Delete this? It cannot be undone.',
  loadMore: 'Load more', more: 'Show more', reachedEnd: '— That is everything —', trash: 'Trash',
  untitledNovel: 'Untitled story', untitledDoc: 'Untitled document', untitled: 'Untitled',
  /** 启动时从环境变量里认出的供应商，会以这个名字落库。 */
  providerFromEnv: '{name} (from environment)',
};

export const error: Locale['error'] = {
  title: 'Something went wrong', titleSuffix: ' error',
  desc: 'This part failed to load. Try again; if it still fails, copy the details and send them to us.',
  detail: 'Error details', feedback: 'Copy error details',
  copied: 'Details copied — just paste them and send them over', copyFail: 'Copy failed. You can select the text above by hand.',
  backHome: 'Back to bookshelf', routeScope: 'Page', startFailed: 'Startup failed',
  appScope: 'App', startScope: 'Startup',
  runtimeError: 'Runtime error: {message}', unhandledError: 'Unhandled error: {message}',
  notFoundTitle: 'Nothing here', notFoundDesc: '“{path}” is not a page that exists. The link may have expired.',
};

/**
 * 任务状态与任务类型的唯一文案出处。
 *
 * 措辞取面向读者的那一套，与中文词典保持一致。
 */
export const jobs: Locale['jobs'] = {
  status: {
    queued: 'Queued', running: 'AI is writing', pausing: 'Pausing', paused: 'Paused',
    cancelling: 'Stopping', cancelled: 'Cancelled', failed: 'Ran into a problem', completed: 'Done',
  },
  type: {
    generate_novel: 'Write the whole book', regenerate_chapter: 'Rewrite a chapter', rewrite: 'Revise a chapter',
    extract_style: 'Extract writing style', style_check: 'Review a chapter', planning: 'Plan the outline and chapters',
  },
};

/** 小说自身的状态（与任务状态是两回事，别再各写一份）。 */
export const novelStatus: Locale['novelStatus'] = {
  draft: 'Brewing', planning: 'Planning', generating: 'AI is writing', writing: 'In progress', complete: 'Finished',
};

/** 无障碍专用文案：只给读屏软件听，不显示在界面上。 */
export const a11y: Locale['a11y'] = {
  closeDialog: 'Close dialog', notifications: 'Notifications', deleteItem: 'Delete “{name}”',
};
