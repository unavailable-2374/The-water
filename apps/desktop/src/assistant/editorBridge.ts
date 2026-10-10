import type { AssistantContext } from '@the-water/shared';
interface EditorBinding {
  novelId: string;
  chapterId: string;
  flush: () => Promise<AssistantContext>;
}
const editors = new Map<string, EditorBinding>();
const drafts = new Set<{ novelId: string; flush: () => Promise<void> }>();
export function registerAssistantDraft(binding: { novelId: string; flush: () => Promise<void> }) {
  drafts.add(binding);
  return () => {
    drafts.delete(binding);
  };
}
/** The editor retains ownership of its unsaved text and save queue. */
export function registerAssistantEditor(binding: EditorBinding) {
  editors.set(binding.chapterId, binding);
  return () => {
    if (editors.get(binding.chapterId) === binding) editors.delete(binding.chapterId);
  };
}
export async function flushAssistantEditors(
  novelId: string | null,
  selectedChapterId?: string | null,
): Promise<AssistantContext | null> {
  for (const draft of drafts) if (draft.novelId === novelId) await draft.flush();
  let selected: AssistantContext | null = null;
  for (const editor of editors.values())
    if (editor.novelId === novelId) {
      const context = await editor.flush();
      if (editor.chapterId === selectedChapterId) selected = context;
    }
  return selected;
}
