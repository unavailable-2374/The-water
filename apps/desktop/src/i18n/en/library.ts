/** 书架（文档 / 小说两个 tab）与回收站。 */
import type { Locale } from '../shape';

export const library: Locale['library'] = {
  newNovel: 'New story', importText: 'Import text',
  lastRead: 'Last read on page {page}',
  importing: 'Importing…', duplicate: 'This file has already been imported',

  /* ---------------- 书架（文档） ---------------- */
  docsTitle: 'Bookshelf',
  docsSubtitle: '{count} books, ready when you are',
  docsSubtitleEmpty: 'Add the PDF, EPUB, TXT or Markdown files you want to read, or just drag them into the window',
  importDoc: 'Import document',
  importFirst: 'Import your first book',
  docsEmptyTitle: 'Your shelf is empty',
  docsEmptyDesc: 'Import a PDF, EPUB, TXT or Markdown file to start reading — you can also drag files straight into the window. Select any passage to talk it over with AI.',
  docsListLabel: 'Books on the shelf',
  readPct: '{pct}% read',
  notStarted: '{pages} pages · not started',
  docCardReading: '“{name}”, {pct}% read',
  docCardNotStarted: '“{name}”, not started yet',
  importOk: 'Added to your shelf: {name}',
  importFail: 'Import failed: {message}',
  duplicateOf: 'This file has already been imported: {name}',
  restoredFromTrash: 'Restored to your shelf from Trash: {name}',

  /* ---------------- 我的故事（小说） ---------------- */
  novelsTitle: 'My stories',
  novelsSubtitle: '{count} stories on your desk',
  novelsSubtitleEmpty: 'Write down an idea and let AI turn it into a book',
  newStory: 'Start a new story',
  novelsEmptyTitle: 'No stories yet',
  novelsEmptyDesc: 'Tell AI what kind of story you want: the genre, the characters, where it should end up. It will draft an outline first, and only start writing once you are happy with it.',
  novelsListLabel: 'Stories I have written',
  noPremise: 'No premise written yet',
  derived: 'Remix', published: 'Published',
  charsProgress: '{chars} / {target} words',
  novelCard: '“{name}”, {status}, {pct}% written',
  writeProgress: 'Writing progress',

  /* ---------------- 回收站入口与软删除 ---------------- */
  trashHint: 'Deleted books and stories stay in Trash for {days} days',
  trashDocTitle: 'Move “{name}” to Trash?',
  trashDocDesc: 'You can restore it from Trash within {days} days — notes and reading progress included.',
  trashNovelTitle: 'Move “{name}” to Trash?',
  trashNovelDesc: 'Chapters, versions and story bible go to Trash with it, and can all be restored within {days} days.',
  toTrash: 'Move to Trash',
  trashedOk: 'Moved to Trash: {name}',

  /** 加载 / 出错。 */
  loadingDocs: 'Loading your shelf…',
  loadingNovels: 'Loading your stories…',
  loadFailed: 'Could not load it: {message}',

  /* ---------------- 回收站对话框 ---------------- */
  trash: {
    subtitle: 'Deleted items stay here for {days} days, then clear out on their own',
    emptyTitle: 'Trash is empty',
    emptyDesc: 'Deleted books and stories land here first, so you can always pull them back.',
    listLabel: 'Items in Trash',
    loading: 'Loading Trash…',
    noPremise: 'No premise written',
    docKind: 'PDF document',
    deletedAt: 'Deleted {time}',
    daysLeft: '{days} days left',
    expiring: 'Clearing out soon',
    restore: 'Restore',
    restoreItem: 'Restore “{name}”',
    restored: 'Back on your shelf: {name}',
    purge: 'Delete forever',
    purgeItem: 'Delete “{name}” forever',
    purgeTitle: 'Delete “{name}” forever?',
    purgeNovelDesc: 'Every chapter, version and story line goes with it. This cannot be undone.',
    purgeDocDesc: 'The book, its reading progress and its notes all go with it. This cannot be undone.',
    purged: 'Deleted forever: {name}',
  },
};
