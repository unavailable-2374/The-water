import { create } from 'zustand';
import type { DocumentRow } from '@/db/repos/documentsRepo';
import { ensureSearchIndex, pruneOrphanSearchIndex } from '@/db/repos/documentsRepo';
import { indexDocumentText } from '@/pdf/textIndex';
import { openDocumentSource } from './open';
import type { DocumentSource } from './types';

export type IndexStatus = 'running' | 'done' | 'cancelled' | 'error';

export interface IndexTask {
  documentId: string;
  title: string;
  done: number;
  total: number;
  status: IndexStatus;
  error?: string;
}

interface QueueState {
  tasks: Record<string, IndexTask>;
  cancel: (documentId: string) => void;
  clear: (documentId: string) => void;
  /** 内部用 */
  update: (documentId: string, patch: Partial<IndexTask>) => void;
}

const cancelled = new Set<string>();

export const useIndexQueue = create<QueueState>((set) => ({
  tasks: {},
  cancel: (documentId) => {
    cancelled.add(documentId);
    set((s) => (s.tasks[documentId] ? { tasks: { ...s.tasks, [documentId]: { ...s.tasks[documentId]!, status: 'cancelled' } } } : s));
  },
  clear: (documentId) =>
    set((s) => {
      const next = { ...s.tasks };
      delete next[documentId];
      return { tasks: next };
    }),
  update: (documentId, patch) =>
    set((s) => {
      const cur = s.tasks[documentId];
      if (!cur) return s;
      return { tasks: { ...s.tasks, [documentId]: { ...cur, ...patch } } };
    }),
}));

/** 这本书是不是正在建索引。 */
export function isIndexing(documentId: string): boolean {
  return useIndexQueue.getState().tasks[documentId]?.status === 'running';
}

/**
 * 在后台给一本书建全文索引：导入完就排上，不阻塞打开与阅读，随时可以取消。
 * 传了 source 就复用（阅读器已经打开的那一份），否则自己开一份读完关掉。
 */
export function startIndexing(doc: Pick<DocumentRow, 'id' | 'title' | 'fileRelPath'>, source?: DocumentSource): void {
  const store = useIndexQueue.getState();
  if (store.tasks[doc.id]?.status === 'running') return;
  cancelled.delete(doc.id);
  useIndexQueue.setState((s) => ({
    tasks: { ...s.tasks, [doc.id]: { documentId: doc.id, title: doc.title, done: 0, total: source?.numPages ?? 0, status: 'running' } },
  }));
  void run(doc, source);
}

async function run(doc: Pick<DocumentRow, 'id' | 'title' | 'fileRelPath'>, provided?: DocumentSource): Promise<void> {
  const update = useIndexQueue.getState().update;
  let owned: DocumentSource | null = null;
  try {
    const source = provided ?? (owned = await openDocumentSource(doc));
    update(doc.id, { total: source.numPages });
    const result = await indexDocumentText(source, doc.id, {
      onProgress: (done, total) => update(doc.id, { done, total }),
      shouldStop: () => cancelled.has(doc.id),
    });
    if (result === 'stopped') {
      update(doc.id, { status: 'cancelled' });
      return;
    }
    await ensureSearchIndex(doc.id);
    await pruneOrphanSearchIndex();
    update(doc.id, { status: 'done' });
  } catch (e) {
    update(doc.id, { status: 'error', error: e instanceof Error ? e.message : String(e) });
  } finally {
    if (owned) await owned.close().catch(() => undefined);
    cancelled.delete(doc.id);
  }
}

/**
 * 打开文档时补索引：没建过就后台建，建过的补一次 FTS（老书在 FTS 表之前入的库）。
 * 后台任务自己开一份文档源，这样离开阅读器也不会被中断。
 */
export async function ensureIndexed(doc: DocumentRow): Promise<void> {
  if (!doc.textIndexed) {
    startIndexing(doc);
    return;
  }
  await ensureSearchIndex(doc.id).catch(() => 0);
}
