import { create } from 'zustand';
import type { Anchor, Highlight, HighlightKind } from '@/db/repos/highlightsRepo';
import { createHighlight, deleteHighlight, listHighlights, updateHighlight } from '@/db/repos/highlightsRepo';
import { getPageTexts } from '@/db/repos/documentsRepo';
import { getSetting, setSetting } from '@/db/repos/settingsRepo';
import { relocateHighlights, type Located } from '@/documents/relocate';
import type { SearchHit } from '@/documents/search';
import { stepHit } from '@/documents/search';
import { indexByPage, insertHighlight, patchHighlight, removeHighlight, type HighlightIndex } from '@/features/reader/highlightIndex';

export interface Selection {
  pageNo: number;
  text: string;
  start: number;
  end: number;
  rects: Array<{ x: number; y: number; w: number; h: number }>;
  /** viewport position for the popover (client coords) */
  clientX: number;
  /** 选区底边，气泡默认贴在它下面 */
  clientY: number;
  /** 选区顶边，下方放不下时气泡翻到上面 */
  clientTop: number;
}

/** 纸 / 夜 / 护眼 */
export type ReaderTheme = 'paper' | 'night' | 'eye';
export type LeftPanel = 'none' | 'outline' | 'thumbs';

export interface SearchState {
  query: string;
  hits: SearchHit[];
  index: number;
  truncated: boolean;
  engine: 'fts' | 'like';
  pages: number;
  running: boolean;
}

const EMPTY_SEARCH: SearchState = { query: '', hits: [], index: -1, truncated: false, engine: 'fts', pages: 0, running: false };

export const SIDEBAR_MIN = 280;
export const SIDEBAR_MAX = 720;
export const SIDEBAR_DEFAULT = 380;

const KEY_THEME = 'readerTheme';
const KEY_WIDTH = 'readerSidebarWidth';
const KEY_COLLAPSED = 'readerSidebarCollapsed';

interface ReaderState {
  documentId: string | null;
  scale: number;
  currentPage: number;
  numPages: number;
  highlights: Highlight[];
  /** 按页索引：页面渲染只取自己那一页 */
  byPage: HighlightIndex;
  /** 锚点重定位结果，key 是高亮 id */
  locations: Record<string, Located>;
  selection: Selection | null;
  sidePanel: 'ai' | 'notes' | 'search';
  leftPanel: LeftPanel;
  theme: ReaderTheme;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  helpOpen: boolean;
  search: SearchState;
  /** 每按一次 Cmd+F 就 +1，搜索面板据此把焦点抢回输入框 */
  searchFocusNonce: number;
  pendingAsk: { text: string; pageNo: number } | null;
  scrollToPage: number | null;
  focusHighlightId: string | null;
  setDocument: (id: string, scale: number, page: number) => void;
  setScale: (s: number) => void;
  zoomBy: (delta: number) => void;
  setCurrentPage: (p: number) => void;
  setNumPages: (n: number) => void;
  refreshHighlights: () => Promise<void>;
  /** 打开文档时整本重定位一遍 */
  relocateAll: () => Promise<void>;
  addHighlight: (input: { pageNo: number; kind: HighlightKind; color: string; anchor: Anchor; noteText?: string }) => Promise<void>;
  editHighlight: (id: string, patch: { noteText?: string; color?: string; kind?: HighlightKind }) => Promise<void>;
  dropHighlight: (id: string) => Promise<void>;
  /** 重定位后按新的文字位置修好矩形 */
  repairRects: (id: string, rects: Anchor['rects']) => Promise<void>;
  setSelection: (s: Selection | null) => void;
  setSidePanel: (p: ReaderState['sidePanel']) => void;
  setLeftPanel: (p: LeftPanel) => void;
  toggleLeftPanel: (p: LeftPanel) => void;
  setTheme: (t: ReaderTheme) => void;
  setSidebarWidth: (w: number, persist?: boolean) => void;
  toggleSidebar: () => void;
  setHelpOpen: (open: boolean) => void;
  loadPreferences: () => Promise<void>;
  setSearch: (patch: Partial<SearchState>) => void;
  openSearch: () => void;
  gotoHit: (index: number) => void;
  stepSearch: (delta: number) => void;
  clearSearch: () => void;
  ask: (text: string, pageNo: number) => void;
  consumeAsk: () => void;
  jumpTo: (page: number, highlightId?: string) => void;
  consumeJump: () => void;
}

const clampWidth = (w: number) => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(w)));

export const useReader = create<ReaderState>((set, get) => ({
  documentId: null, scale: 1.2, currentPage: 1, numPages: 0, highlights: [], byPage: {}, locations: {},
  selection: null, sidePanel: 'ai', leftPanel: 'none', theme: 'paper', sidebarWidth: SIDEBAR_DEFAULT, sidebarCollapsed: false,
  helpOpen: false, search: EMPTY_SEARCH, searchFocusNonce: 0, pendingAsk: null, scrollToPage: null, focusHighlightId: null,

  setDocument: (id, scale, page) => set({
    documentId: id, scale, currentPage: page, highlights: [], byPage: {}, locations: {},
    selection: null, scrollToPage: page, search: EMPTY_SEARCH, leftPanel: 'none',
  }),
  setScale: (scale) => set({ scale: +Math.max(0.4, Math.min(4, scale)).toFixed(2) }),
  zoomBy: (delta) => set((s) => ({ scale: +Math.max(0.4, Math.min(4, s.scale + delta)).toFixed(2) })),
  setCurrentPage: (currentPage) => set({ currentPage }),
  setNumPages: (numPages) => set({ numPages }),

  refreshHighlights: async () => {
    const id = get().documentId;
    if (!id) return;
    const highlights = await listHighlights(id);
    set({ highlights, byPage: indexByPage(highlights) });
  },

  relocateAll: async () => {
    const { documentId, highlights } = get();
    if (!documentId || highlights.length === 0) return;
    const texts = await getPageTexts(documentId, highlights.map((h) => h.pageNo));
    set({ locations: relocateHighlights(highlights, texts) });
  },

  addHighlight: async (input) => {
    const documentId = get().documentId;
    if (!documentId) return;
    const created = await createHighlight({ documentId, ...input });
    // 乐观更新：直接把新条目并进列表，不再全量重取
    set((s) => {
      const highlights = insertHighlight(s.highlights, created);
      return { highlights, byPage: indexByPage(highlights), locations: { ...s.locations, [created.id]: { status: 'ok', start: created.anchor.start, end: created.anchor.end } } };
    });
  },

  editHighlight: async (id, patch) => {
    const before = get().highlights;
    set((s) => {
      const highlights = patchHighlight(s.highlights, id, patch as Partial<Highlight>);
      return { highlights, byPage: indexByPage(highlights) };
    });
    try {
      await updateHighlight(id, patch);
    } catch (e) {
      set({ highlights: before, byPage: indexByPage(before) });
      throw e;
    }
  },

  dropHighlight: async (id) => {
    const before = get().highlights;
    set((s) => {
      const highlights = removeHighlight(s.highlights, id);
      const locations = { ...s.locations };
      delete locations[id];
      return { highlights, byPage: indexByPage(highlights), locations, focusHighlightId: s.focusHighlightId === id ? null : s.focusHighlightId };
    });
    try {
      await deleteHighlight(id);
    } catch (e) {
      set({ highlights: before, byPage: indexByPage(before) });
      throw e;
    }
  },

  repairRects: async (id, rects) => {
    const cur = get().highlights.find((h) => h.id === id);
    if (!cur) return;
    const loc = get().locations[id];
    const anchor: Anchor = { ...cur.anchor, rects, start: loc?.start ?? cur.anchor.start, end: loc?.end ?? cur.anchor.end };
    set((s) => {
      const highlights = patchHighlight(s.highlights, id, { anchor });
      return { highlights, byPage: indexByPage(highlights), locations: { ...s.locations, [id]: { status: 'ok', start: anchor.start, end: anchor.end } } };
    });
    await updateHighlight(id, { anchor }).catch(() => undefined);
  },

  setSelection: (selection) => set({ selection }),
  setSidePanel: (sidePanel) => set({ sidePanel, sidebarCollapsed: false }),
  setLeftPanel: (leftPanel) => set({ leftPanel }),
  toggleLeftPanel: (p) => set((s) => ({ leftPanel: s.leftPanel === p ? 'none' : p })),

  setTheme: (theme) => {
    set({ theme });
    void setSetting(KEY_THEME, theme);
  },
  setSidebarWidth: (w, persist = true) => {
    const sidebarWidth = clampWidth(w);
    set({ sidebarWidth });
    // 拖动过程中只更新界面，松手时才落盘
    if (persist) void setSetting(KEY_WIDTH, sidebarWidth);
  },
  toggleSidebar: () => {
    const sidebarCollapsed = !get().sidebarCollapsed;
    set({ sidebarCollapsed });
    void setSetting(KEY_COLLAPSED, sidebarCollapsed);
  },
  setHelpOpen: (helpOpen) => set({ helpOpen }),

  loadPreferences: async () => {
    const [theme, width, collapsed] = await Promise.all([
      getSetting<ReaderTheme>(KEY_THEME, 'paper'),
      getSetting<number>(KEY_WIDTH, SIDEBAR_DEFAULT),
      getSetting<boolean>(KEY_COLLAPSED, false),
    ]);
    set({
      theme: theme === 'night' || theme === 'eye' ? theme : 'paper',
      sidebarWidth: clampWidth(Number(width) || SIDEBAR_DEFAULT),
      sidebarCollapsed: Boolean(collapsed),
    });
  },

  setSearch: (patch) => set((s) => ({ search: { ...s.search, ...patch } })),
  openSearch: () => set((s) => ({ sidePanel: 'search', sidebarCollapsed: false, searchFocusNonce: s.searchFocusNonce + 1 })),
  gotoHit: (index) => {
    const { hits } = get().search;
    const hit = hits[index];
    if (!hit) return;
    set((s) => ({ search: { ...s.search, index }, scrollToPage: hit.pageNo, focusHighlightId: null }));
  },
  stepSearch: (delta) => {
    const { hits, index } = get().search;
    const next = stepHit(hits.length, index, delta);
    if (next >= 0) get().gotoHit(next);
  },
  clearSearch: () => set({ search: EMPTY_SEARCH }),

  ask: (text, pageNo) => set({ pendingAsk: { text, pageNo }, sidePanel: 'ai', selection: null, sidebarCollapsed: false }),
  consumeAsk: () => set({ pendingAsk: null }),
  jumpTo: (page, highlightId) => set({ scrollToPage: page, focusHighlightId: highlightId ?? null }),
  consumeJump: () => set({ scrollToPage: null }),
}));

/** 当前选中的那一条命中（页面高亮用）。 */
export function activeHit(state: { search: SearchState }): SearchHit | null {
  return state.search.hits[state.search.index] ?? null;
}
