import { create } from 'zustand';
import type { Highlight } from '@/db/repos/highlightsRepo';
import { listHighlights } from '@/db/repos/highlightsRepo';

export interface Selection {
  pageNo: number;
  text: string;
  start: number;
  end: number;
  rects: Array<{ x: number; y: number; w: number; h: number }>;
  /** viewport position for the popover (client coords) */
  clientX: number;
  clientY: number;
}

interface ReaderState {
  documentId: string | null;
  scale: number;
  currentPage: number;
  numPages: number;
  highlights: Highlight[];
  selection: Selection | null;
  sidePanel: 'ai' | 'notes' | 'search';
  pendingAsk: { text: string; pageNo: number } | null;
  scrollToPage: number | null;
  focusHighlightId: string | null;
  setDocument: (id: string, scale: number, page: number) => void;
  setScale: (s: number) => void;
  setCurrentPage: (p: number) => void;
  setNumPages: (n: number) => void;
  refreshHighlights: () => Promise<void>;
  setSelection: (s: Selection | null) => void;
  setSidePanel: (p: ReaderState['sidePanel']) => void;
  ask: (text: string, pageNo: number) => void;
  consumeAsk: () => void;
  jumpTo: (page: number, highlightId?: string) => void;
  consumeJump: () => void;
}

export const useReader = create<ReaderState>((set, get) => ({
  documentId: null, scale: 1.2, currentPage: 1, numPages: 0, highlights: [], selection: null, sidePanel: 'ai', pendingAsk: null, scrollToPage: null, focusHighlightId: null,
  setDocument: (id, scale, page) => set({ documentId: id, scale, currentPage: page, highlights: [], selection: null, scrollToPage: page }),
  setScale: (scale) => set({ scale }),
  setCurrentPage: (currentPage) => set({ currentPage }),
  setNumPages: (numPages) => set({ numPages }),
  refreshHighlights: async () => { const id = get().documentId; if (id) set({ highlights: await listHighlights(id) }); },
  setSelection: (selection) => set({ selection }),
  setSidePanel: (sidePanel) => set({ sidePanel }),
  ask: (text, pageNo) => set({ pendingAsk: { text, pageNo }, sidePanel: 'ai', selection: null }),
  consumeAsk: () => set({ pendingAsk: null }),
  jumpTo: (page, highlightId) => set({ scrollToPage: page, focusHighlightId: highlightId ?? null }),
  consumeJump: () => set({ scrollToPage: null }),
}));
